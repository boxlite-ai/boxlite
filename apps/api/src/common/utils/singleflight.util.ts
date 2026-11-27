/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class Singleflight {
  private readonly inFlight = new Map<string, Promise<unknown>>()

  run<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined
    if (existing) return existing

    const pending = Promise.resolve()
      .then(loader)
      .finally(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
      })
    this.inFlight.set(key, pending)
    return pending
  }
}
