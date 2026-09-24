/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { isDigestPinned, parseImageRef } from '../utils/image-ref.util'

/**
 * The build each runner booted for a curated tag, handed back to that runner.
 *
 * A runner asks the registry about a tag whenever it builds a new disk from
 * one. A tenant's tag is asked about once and then pinned by the catalog; the
 * curated set has no catalog, so without this every curated box would ask —
 * for the images every organization boots, against an anonymous limit that a
 * runner's whole address shares. Handing a runner the digest it reported keeps
 * a curated box on that runner's cache, which is how curated boxes always ran.
 *
 * Per runner, not shared: the digest a runner reports is its own platform's
 * build, which a runner of another architecture cannot boot. First write wins
 * for the same reason the cache's did — a runner keeps the build it has until
 * an operator rotates the ref, and a rotated ref is a new key.
 */
@Injectable()
export class CuratedImagePinService {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  /** Record the build a runner reported for a curated ref. */
  async remember(runnerId: string, ref: string, digest: string): Promise<void> {
    if (isDigestPinned(ref)) {
      return
    }
    await this.redis.hsetnx(pinsKey(runnerId), ref, digest)
  }

  /** The ref to hand a runner for a curated image: pinned once that runner has booted it. */
  async refFor(runnerId: string, ref: string): Promise<string> {
    if (isDigestPinned(ref)) {
      return ref
    }
    const digest = await this.redis.hget(pinsKey(runnerId), ref)
    if (!digest) {
      return ref
    }
    // The spelling the runner's cache indexes a pulled build under, so the
    // pinned ref is a cache hit rather than a second pull.
    const { host, repository } = parseImageRef(ref)
    return `${host}/${repository}@${digest}`
  }
}

function pinsKey(runnerId: string): string {
  return `image:curated-pins:${runnerId}`
}
