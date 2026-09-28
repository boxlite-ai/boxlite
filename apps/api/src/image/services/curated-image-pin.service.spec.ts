/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import Redis from 'ioredis'
import { CuratedImagePinService } from './curated-image-pin.service'

const CURATED = 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`

/** Just the two hash commands the service uses, with Redis semantics. */
function fakeRedis() {
  const hashes = new Map<string, Map<string, string>>()
  const hash = (key: string) => {
    let fields = hashes.get(key)
    if (!fields) {
      fields = new Map()
      hashes.set(key, fields)
    }
    return fields
  }
  return {
    hsetnx: jest.fn(async (key: string, field: string, value: string) => {
      if (hash(key).has(field)) {
        return 0
      }
      hash(key).set(field, value)
      return 1
    }),
    hget: jest.fn(async (key: string, field: string) => hash(key).get(field) ?? null),
  }
}

describe('CuratedImagePinService', () => {
  let redis: ReturnType<typeof fakeRedis>
  let pins: CuratedImagePinService

  beforeEach(() => {
    redis = fakeRedis()
    pins = new CuratedImagePinService(redis as unknown as Redis)
  })

  it('passes a curated tag through until the runner has booted it', async () => {
    expect(await pins.refFor('runner-1', CURATED)).toBe(CURATED)
  })

  it('hands a runner the digest it reported, spelled the way its cache finds it', async () => {
    await pins.remember('runner-1', CURATED, DIGEST)

    expect(await pins.refFor('runner-1', CURATED)).toBe(`ghcr.io/boxlite-ai/boxlite-agent-base@${DIGEST}`)
  })

  /**
   * The digest is that runner's platform build. Another runner — possibly
   * another architecture — has to resolve the tag for itself.
   */
  it('keeps one runner pin away from another runner', async () => {
    await pins.remember('runner-arm64', CURATED, DIGEST)

    expect(await pins.refFor('runner-amd64', CURATED)).toBe(CURATED)
  })

  it('keeps the first build a runner booted, as its cache did', async () => {
    await pins.remember('runner-1', CURATED, DIGEST)
    await pins.remember('runner-1', CURATED, OTHER_DIGEST)

    expect(await pins.refFor('runner-1', CURATED)).toBe(`ghcr.io/boxlite-ai/boxlite-agent-base@${DIGEST}`)
  })

  it('leaves a curated ref the operator already pinned alone', async () => {
    const pinned = `ghcr.io/boxlite-ai/boxlite-agent-base@${OTHER_DIGEST}`
    await pins.remember('runner-1', pinned, DIGEST)

    expect(await pins.refFor('runner-1', pinned)).toBe(pinned)
    expect(redis.hsetnx).not.toHaveBeenCalled()
  })
})
