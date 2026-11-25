/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { StateConflict } from '../state/database'

interface Work {
  revision: string
  run: (queueWaitMs: number) => Promise<void>
  running: boolean
  dirty: boolean
  queuedAt: number
}

/** An in-memory index over durable work: one consumer per key, with bounded I/O. */
export class WorkQueue {
  private readonly work = new Map<string, Work>()
  private readonly active = new Set<Promise<void>>()
  private readonly failures = new Map<string, { attempts: number; retryAt: number }>()
  private closed = false
  private failure?: Error
  constructor(
    private readonly concurrency: number,
    private readonly report: (error: unknown) => void,
    private readonly capacity = 4096,
  ) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isSafeInteger(capacity) ||
      capacity < concurrency
    )
      throw new Error('Invalid CI work queue budget')
  }
  revision(key: string): string | undefined {
    return this.work.get(key)?.revision
  }
  isCurrent(key: string, revision: string): boolean {
    const entry = this.work.get(key)
    return !this.closed && !!entry?.running && !entry.dirty && entry.revision === revision
  }
  enqueue(key: string, revision: string, run: (queueWaitMs: number) => Promise<void>): boolean {
    if (this.failure) throw this.failure
    if (this.closed) return false
    const existing = this.work.get(key)
    if (existing) {
      if (existing.running && existing.revision !== revision) existing.dirty = true
      existing.revision = revision
      existing.run = run
      return true
    }
    if (this.work.size >= this.capacity || (this.failures.get(key)?.retryAt ?? 0) > Date.now()) return false
    this.work.set(key, { revision, run, running: false, dirty: false, queuedAt: Date.now() })
    this.pump()
    return true
  }
  async close(): Promise<void> {
    this.closed = true
    for (const [key, entry] of this.work) if (!entry.running) this.work.delete(key)
    await Promise.all(this.active)
    this.failures.clear()
    if (this.failure) throw this.failure
  }
  private pump(): void {
    for (const [key, entry] of this.work) {
      if (this.closed || this.active.size >= this.concurrency) return
      if (entry.running) continue
      entry.running = true
      entry.dirty = false
      const run = entry.run
      const task = Promise.resolve()
        .then(() => run(Date.now() - entry.queuedAt))
        .then(
          () => {
            this.failures.delete(key)
          },
          (error) => {
            const attempts = (this.failures.get(key)?.attempts ?? 0) + 1
            // Repeated failures yield to durable periodic recovery after three attempts.
            this.failures.delete(key)
            this.failures.set(key, {
              attempts,
              retryAt: Date.now() + (attempts >= 3 ? 60000 : 1000 * 2 ** (attempts - 1)),
            })
            if (error instanceof StateConflict) this.failures.delete(key)
            if (this.failures.size > this.capacity) this.failures.delete(this.failures.keys().next().value!)
            if (!(error instanceof StateConflict)) entry.dirty = false
            try {
              this.report(error)
            } catch (reporting) {
              this.failure = new AggregateError([error, reporting], 'CI work reporting failed')
              this.closed = true
            }
          },
        )
        .finally(() => {
          this.active.delete(task)
          if (entry.dirty && !this.closed) {
            entry.running = false
            entry.queuedAt = Date.now()
          } else this.work.delete(key)
          this.pump()
        })
      this.active.add(task)
    }
  }
}
