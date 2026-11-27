/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class TtlLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>()

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('Cache capacity must be positive')
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Cache TTL must be positive')
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as K
      this.entries.delete(oldest)
    }
  }

  delete(key: K): void {
    this.entries.delete(key)
  }
}
