/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import Redis from 'ioredis'
import { IsNull, Repository } from 'typeorm'
import { Organization } from '../../organization/entities/organization.entity'
import { Image } from '../entities/image.entity'
import { ImageColdPullRateLimitedError, ImageCountLimitReachedError } from '../errors/image-admission.error'
import { assertHostIsAllowed, imageRegistryAllowlist, isCuratedSelector, parseImageRef } from '../utils/image-ref.util'
import { ResolvedImage } from './image-resolver.service'

/** Cold pulls one organization may start per window, unless an operator sets another. */
const COLD_PULL_LIMIT_ENV = 'BOXLITE_IMAGE_COLD_PULL_LIMIT'
const DEFAULT_COLD_PULL_LIMIT = 6
/** How long that budget takes to clear. A cold pull runs for roughly a third of the default. */
const COLD_PULL_WINDOW_ENV = 'BOXLITE_IMAGE_COLD_PULL_WINDOW_SECONDS'
const DEFAULT_COLD_PULL_WINDOW_SECONDS = 60

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
  ) {}

  async assert(organization: Organization, image: string | undefined): Promise<void> {
    if (isCuratedSelector(image)) {
      return
    }

    const ref = image as string
    const allowlist = imageRegistryAllowlist()
    const { host, repository } = parseImageRef(ref)
    assertHostIsAllowed(host, allowlist)

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
   */
  async spendColdPullBudget(organization: Organization, resolved: ResolvedImage): Promise<void> {
    if (!resolved.isOrgOwned || resolved.imageId) {
      return
    }
    await this.assertPullBudget(organization)
  }

  /**
   * Refuse a new image once the organization holds its limit.
   *
   * The caller checks it before spending the pull budget, so a create it
   * refuses does not spend one: the budget has no way to give a slot back.
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

  private async assertPullBudget(organization: Organization): Promise<void> {
    const key = `image:coldpull:${organization.id}`
    const started = await this.redis.incr(key)
    if (started === 1) {
      await this.redis.expire(key, this.coldPullWindowSeconds)
    }
    if (started > this.coldPullLimit) {
      // A key that somehow lost its TTL would block the organization forever,
      // so read the remaining time rather than assuming a full window, and
      // restore the expiry when it is missing.
      const ttl = await this.redis.ttl(key)
      if (ttl < 0) {
        await this.redis.expire(key, this.coldPullWindowSeconds)
      }
      throw new ImageColdPullRateLimitedError(
        this.coldPullLimit,
        this.coldPullWindowSeconds,
        ttl > 0 ? ttl : this.coldPullWindowSeconds,
      )
    }
  }
}
