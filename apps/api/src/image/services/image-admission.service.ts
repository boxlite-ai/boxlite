/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import { Organization } from '../../organization/entities/organization.entity'
import { ImageColdPullRateLimitedError } from '../errors/image-admission.error'
import { assertHostIsAllowed, imageRegistryAllowlist, isCuratedSelector, parseImageRef } from '../utils/image-ref.util'

/** Image pulls one organization may start per window. */
const COLD_PULL_LIMIT = 3
/** How long that budget takes to clear. A cold pull runs for roughly a third of it. */
const COLD_PULL_WINDOW_SECONDS = 60

/**
 * The gate a tenant-supplied image passes before a box is created from it.
 *
 * It replaces the curated-only check, which refused everything it did not
 * recognise. Refusing everything was itself a protection: the runner pulls onto
 * a disk it shares with other tenants. Opening it therefore has to put back,
 * one at a time, each thing the blanket refusal was doing — which registries
 * may be reached, and how fast one organization may start downloads.
 *
 * The per-organization catalog limit is not here. It counts rows in a table
 * nothing writes until the registrar lands, so a check placed here would read
 * zero forever: a limit that cannot fire is worse than a missing one, because
 * it reads as enforced. It arrives with its writer.
 *
 * Curated selectors skip all of it and touch neither Redis nor the database:
 * they are operator-chosen refs that were already allowed, and making the
 * common path pay for the new one would show up as latency on every create.
 */
@Injectable()
export class ImageAdmissionService {
  constructor(
    @InjectRedis()
    private readonly redis: Redis,
  ) {}

  async assert(organization: Organization, image: string | undefined): Promise<void> {
    if (isCuratedSelector(image)) {
      return
    }

    const allowlist = imageRegistryAllowlist()
    const { host } = parseImageRef(image as string)
    assertHostIsAllowed(host, allowlist)

    await this.assertPullBudget(organization)
  }

  private async assertPullBudget(organization: Organization): Promise<void> {
    const key = `image:coldpull:${organization.id}`
    const started = await this.redis.incr(key)
    if (started === 1) {
      await this.redis.expire(key, COLD_PULL_WINDOW_SECONDS)
    }
    if (started > COLD_PULL_LIMIT) {
      // A key that somehow lost its TTL would block the organization forever,
      // so read the remaining time rather than assuming a full window, and
      // restore the expiry when it is missing.
      const ttl = await this.redis.ttl(key)
      if (ttl < 0) {
        await this.redis.expire(key, COLD_PULL_WINDOW_SECONDS)
      }
      throw new ImageColdPullRateLimitedError(
        COLD_PULL_LIMIT,
        COLD_PULL_WINDOW_SECONDS,
        ttl > 0 ? ttl : COLD_PULL_WINDOW_SECONDS,
      )
    }
  }
}
