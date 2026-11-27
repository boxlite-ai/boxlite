/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import Redis from 'ioredis'
import { IsNull, Repository } from 'typeorm'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Organization } from '../../organization/entities/organization.entity'
import { RegistryCredentialService } from '../../registry/services/registry-credential.service'
import { credentialedRegistryHosts, registryProxyHost } from '../../registry/utils/registry-proxy.util'
import { Image } from '../entities/image.entity'
import { ImageColdPullRateLimitedError, ImageCountLimitReachedError } from '../errors/image-admission.error'
import {
  assertHostIsAllowed,
  assertNotThroughRegistryProxy,
  imageRegistryAllowlist,
  isCuratedSelector,
  parseImageRef,
} from '../utils/image-ref.util'
import { ResolvedImage } from './image-resolver.service'

/** Cold pulls one organization may start per window, unless an operator sets another. */
const COLD_PULL_LIMIT_ENV = 'BOXLITE_IMAGE_COLD_PULL_LIMIT'
const DEFAULT_COLD_PULL_LIMIT = 6
/** How long that budget takes to clear. A cold pull runs for roughly a third of the default. */
const COLD_PULL_WINDOW_ENV = 'BOXLITE_IMAGE_COLD_PULL_WINDOW_SECONDS'
const DEFAULT_COLD_PULL_WINDOW_SECONDS = 60

/**
 * The ticket a cold-pull spend hands back, and a refund must present.
 *
 * `generation` names the exact window the charge landed in — the value the
 * charge wrote to the window's generation key, which expires with the window.
 * A refund whose ticket names a window that is gone, or has been replaced by
 * a newer generation, is refused: it must never discount a window it did not
 * pay for. `spent` is one charged cold pull, independently of the window's
 * cumulative count, so a refund returns only this call's charge.
 */
export interface ColdPullTicket {
  generation: string
  spent: number
}

/**
 * Charge one cold pull and stamp the window's generation, atomically.
 *
 * The counter and its generation stamp live and expire together; the
 * generation source — a plain never-expiring counter — does not. Each window
 * rebuild takes the next number, so generations never repeat for one
 * organization and a refund can tell the window it paid for from any later
 * one, even one that starts with the same count. When the limit is crossed,
 * the last over-limit calls stay counted — the window refuses further work
 * either way, and its TTL, which the error reports, still reads true.
 *
 * Time       window 1                 window 2
 * spend A    +1, ticket generation 1
 * expiry     counter and stamp end
 * spend B                             +1, ticket generation 2
 * refund A                            generation mismatch; count stays 1
 *
 * KEYS[1] counter, KEYS[2] generation stamp, KEYS[3] generation sequence.
 * ARGV[1] window seconds, ARGV[2] limit.
 * Returns { new count, generation, counter pttl }.
 */
const COLD_PULL_SPEND_SCRIPT = `
local newWindow = redis.call('EXISTS', KEYS[1]) == 0
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = redis.call('PTTL', KEYS[1])
end
if newWindow or redis.call('EXISTS', KEYS[2]) == 0 then
  local generation = redis.call('INCR', KEYS[3])
  redis.call('SET', KEYS[2], generation)
end
redis.call('PEXPIRE', KEYS[2], ttl)
return {count, redis.call('GET', KEYS[2]), ttl}
`

/**
 * Give back exactly the units a spend charged, but only to the window the
 * spend paid for.
 *
 * The refund runs only when the generation key still holds the ticket's
 * generation — the same window, unexpired, unreplaced. It also floors the
 * counter at zero, so a manual trim of the counter cannot be driven negative
 * by a refund for charges that are already gone. If the generation has moved
 * on or expired, the refund is a no-op: the charge died with its window.
 *
 * KEYS[1] counter, KEYS[2] generation; ARGV[1] ticket generation,
 * ARGV[2] charged count. Returns the new counter value, or the old one when
 * the ticket does not match.
 */
const COLD_PULL_REFUND_SCRIPT = `
if redis.call('GET', KEYS[2]) ~= ARGV[1] then
  return redis.call('GET', KEYS[1]) or 0
end
local count = redis.call('GET', KEYS[1])
if not count then
  return 0
end
count = tonumber(count) - tonumber(ARGV[2])
if count < 0 then
  count = 0
end
redis.call('SET', KEYS[1], count, 'KEEPTTL')
return count
`

/**
 * A positive integer from the environment, or `fallback` when it is unset.
 * Anything else stops the API at boot: a limit an operator mistyped must not
 * quietly become the default, or no limit at all.
 */
function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`)
  }
  return value
}

/**
 * The gate a tenant-supplied image passes before a box is created from it.
 *
 * It replaces the curated-only check, which refused everything it did not
 * recognise. Refusing everything was itself a protection: the runner pulls onto
 * a disk it shares with other tenants. Opening it therefore has to put back,
 * one at a time, each thing the blanket refusal was doing — which registries
 * may be reached, and how fast one organization may start downloads.
 *
 * The per-organization catalog limit lives here too, and could not until the
 * registrar existed to write the rows it counts. It counts kinds of image
 * rather than bytes, and never refuses one the organization already holds:
 * booting a cached image again adds nothing to any runner's disk.
 *
 * A registered login is a second way in, beside the allowlist. A host off the
 * list is admitted when the organization registered a login that covers the
 * repository, because then the pull goes through the registry proxy with that
 * login rather than out from a runner. Only the hosts a login may be registered
 * for take that path, so a login cannot open the metadata endpoint or any other
 * address the allowlist keeps out.
 *
 * Curated selectors skip all of it and touch neither Redis nor the database:
 * they are operator-chosen refs that were already allowed, and making the
 * common path pay for the new one would show up as latency on every create.
 */
@Injectable()
export class ImageAdmissionService {
  private readonly coldPullLimit = positiveIntegerFromEnv(COLD_PULL_LIMIT_ENV, DEFAULT_COLD_PULL_LIMIT)
  private readonly coldPullWindowSeconds = positiveIntegerFromEnv(
    COLD_PULL_WINDOW_ENV,
    DEFAULT_COLD_PULL_WINDOW_SECONDS,
  )

  constructor(
    @InjectRedis()
    private readonly redis: Redis,
    @InjectRepository(Image)
    private readonly imageRepository: Repository<Image>,
    private readonly registryCredentials: RegistryCredentialService,
  ) {
    // At boot, because the allowlist is how a runner is told a host is public:
    // listing the proxy there would admit a hand-written proxy ref, and the
    // runner holds a key for that host.
    const proxyHost = registryProxyHost()
    if (proxyHost && imageRegistryAllowlist().includes(proxyHost)) {
      throw new Error(`BOXLITE_IMAGE_REGISTRY_ALLOWLIST lists the registry proxy '${proxyHost}'; remove it`)
    }
  }

  async assert(organization: Organization, image: string | undefined): Promise<void> {
    if (isCuratedSelector(image)) {
      return
    }

    const ref = image as string
    const { host, repository } = parseImageRef(ref)
    assertNotThroughRegistryProxy(host)

    const allowlist = imageRegistryAllowlist()
    if (
      !allowlist.includes(host) &&
      !(await this.registryCredentials.routesThroughProxy(organization.id, host, repository))
    ) {
      // A host a login could open is told so, and both places to add one: the
      // console and the SDK's runtime handle. Any other host gets the
      // allowlist's own refusal.
      if (registryProxyHost() && credentialedRegistryHosts().includes(host)) {
        throw new BadRequestError(
          `Image registry '${host}' is reachable only with a registered credential for this repository; add one under Registries in the console, or with the SDK's runtime registries handle`,
        )
      }
      assertHostIsAllowed(host, allowlist)
    }

    await this.assertWithinCatalogLimit(organization, `${host}/${repository}`)
  }

  /**
   * Spend one of the organization's cold pulls, unless this create needs none.
   *
   * Only a ref the catalog could not answer is a cold pull. A hit is handed to
   * the runner by digest, a build this deployment already pulled and booted,
   * and the curated set is nobody's; charging those too capped how fast any
   * organization could create boxes from its own images. A hit can still
   * be pulled again by a runner that has not cached it, which the number of
   * runners bounds: once per build per runner.
   *
   * Separate from `assert` because only the resolver knows whether it hit;
   * taking its answer as the argument puts this after the resolver. Running
   * `assert` first, so a refused image never reaches the catalog query, is the
   * caller's to keep.
   *
   * Returns the ticket naming the window generation and the count this call
   * spent. The increment and the generation write are one atomic step: a
   * refund holding an older ticket must never be able to race a fresh window
   * into existence, or it would discount a window it never paid for.
   */
  async spendColdPullBudget(organization: Organization, resolved: ResolvedImage): Promise<ColdPullTicket | undefined> {
    if (!resolved.isOrgOwned || resolved.imageId) {
      return undefined
    }
    const key = `image:coldpull:${organization.id}`
    const [count, generation, pttl] = (await this.redis.eval(
      COLD_PULL_SPEND_SCRIPT,
      3,
      key,
      `${key}:gen`,
      `${key}:genseq`,
      this.coldPullWindowSeconds,
      this.coldPullLimit,
    )) as [number, string, number]

    if (count > this.coldPullLimit) {
      // A key that somehow lost its TTL would block the organization forever;
      // the script restores the expiry, and the answer reports a full window.
      const retryAfterSeconds = pttl >= 0 ? Math.ceil(pttl / 1000) : this.coldPullWindowSeconds
      throw new ImageColdPullRateLimitedError(this.coldPullLimit, this.coldPullWindowSeconds, retryAfterSeconds)
    }
    return { generation, spent: 1 }
  }

  /**
   * Hand one spent cold pull back, for a create whose only effect was that
   * spend: the box limit settles inside the insert, after the budget, and the
   * replay layer treats that rejection as retryable — without the refund,
   * automatic retries would drain the organization's window without a box to
   * show for it.
   *
   * The ticket names the window generation charged. A refund only counts down
   * the same generation: when the window has expired and a newer one replaced
   * it, the ticket no longer matches and the newer window keeps its count, so
   * a late refund cannot discount pulls it never paid for. An expired window
   * is never resurrected either: with no generation left there is nothing to
   * match against and the refund is a no-op.
   */
  async refundColdPullBudget(
    organization: Organization,
    resolved: ResolvedImage,
    ticket: ColdPullTicket,
  ): Promise<void> {
    if (!resolved.isOrgOwned || resolved.imageId) {
      return
    }
    await this.redis.eval(
      COLD_PULL_REFUND_SCRIPT,
      2,
      `image:coldpull:${organization.id}`,
      `image:coldpull:${organization.id}:gen`,
      ticket.generation,
      ticket.spent,
    )
  }

  /**
   * Refuse a new image once the organization holds its limit.
   *
   * It counts only images already recorded, so first pulls still in flight can
   * each pass it; the registrar's count, taken under a lock when a new name is
   * recorded, is what holds the limit. The caller checks it before spending the
   * pull budget, so a create it refuses does not spend one: the budget has no
   * way to give a slot back.
   */
  private async assertWithinCatalogLimit(organization: Organization, name: string): Promise<void> {
    const alreadyHeld = await this.imageRepository.exists({
      where: { organizationId: organization.id, name, deletedAt: IsNull() },
    })
    if (alreadyHeld) {
      return
    }

    const held = await this.imageRepository.count({
      where: { organizationId: organization.id, deletedAt: IsNull() },
    })
    if (held >= organization.imageCountLimit) {
      throw new ImageCountLimitReachedError(organization.imageCountLimit)
    }
  }
}
