/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { TtlLruCache } from './ttl-lru-cache.util'

describe('TtlLruCache', () => {
  afterEach(() => jest.restoreAllMocks())

  it('expires entries and does not return stale values', () => {
    let now = 1_000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const cache = new TtlLruCache<string, number>(2, 60_000)
    cache.set('org', 1)

    now += 59_999
    expect(cache.get('org')).toBe(1)
    now += 1
    expect(cache.get('org')).toBeUndefined()
  })

  it('evicts the least recently used entry at capacity', () => {
    const cache = new TtlLruCache<string, number>(2, 60_000)
    cache.set('first', 1)
    cache.set('second', 2)
    expect(cache.get('first')).toBe(1)

    cache.set('third', 3)

    expect(cache.get('second')).toBeUndefined()
    expect(cache.get('first')).toBe(1)
    expect(cache.get('third')).toBe(3)
  })
})
