/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHash, randomUUID } from 'node:crypto'
import { DeliveryPaginationError } from '../deliveries'
import { GitHubAppSource } from '../github-app'
import { GitHubRequestError } from '../github'
import { object } from '../execution/model'
import { Json, LeaseLost, StateConflict, StateCorrupt, StateRecord } from '../state/database'
import { ExecutionLease, ListenerState, StateChange } from '../state/store'
import {
  candidate,
  initial,
  interval,
  item,
  merge,
  minute,
  progress,
  ReplayItem,
  ReplayProgress,
  retention,
} from './model'
interface Checkpoint {
  row: StateRecord
  value: ReplayProgress
}
export interface DeliveryRecoveryOptions {
  state: ListenerState
  app: () => Pick<GitHubAppSource, 'deliveryPage' | 'redeliver'>
  authorize(lease: ExecutionLease, installation: number | undefined, signal: AbortSignal): Promise<boolean>
  report(error: unknown, operation: string): void
  now?: () => number
  prefix?: string
}
class ScanRestart extends Error {}
class RootDenied extends Error {}
class TargetDeferred extends Error {}
const hash = (cursor: string | null) =>
  createHash('sha256')
    .update(cursor === null ? 'head' : 'cursor:' + cursor)
    .digest('hex')
const json = (value: unknown) => value as Json

/** App-wide metadata recovery. Replayed notifications still enter the ordinary signed inbox. */
export class AppDeliveryRecovery {
  private readonly now: () => number
  private readonly progressKey: string
  private readonly itemPrefix: string
  private task?: Promise<void>
  private stop = new AbortController()
  private leaseKey = ''
  private nextAt = 0
  private closed = false
  constructor(private readonly options: DeliveryRecoveryOptions) {
    this.options = { ...options }
    const prefix = options.prefix ?? 'replay/'
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,149}\/$/.test(prefix)) throw new Error('Invalid App recovery prefix')
    this.progressKey = prefix + 'progress'
    this.itemPrefix = prefix + 'item/'
    this.now = options.now ?? Date.now
  }
  step(original: ExecutionLease, external: AbortSignal): void {
    if (this.closed) throw new Error('App delivery recovery is closed')
    external.throwIfAborted()
    const lease = { ...original },
      key = JSON.stringify(lease)
    if (key !== this.leaseKey) {
      this.stop.abort()
      this.stop = new AbortController()
      this.leaseKey = key
      this.nextAt = 0
    }
    if (this.task || this.nextAt > this.now()) return
    const signal = AbortSignal.any([external, this.stop.signal, AbortSignal.timeout(45000)])
    const task = this.advance(lease, signal)
      .then((nextAt) => {
        if (key === this.leaseKey) this.nextAt = nextAt
      })
      .finally(() => {
        if (this.task === task) this.task = undefined
      })
    this.task = task
  }
  async close(): Promise<void> {
    this.closed = true
    this.stop.abort()
    await this.task
  }
  private async root(lease: ExecutionLease, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!(await this.options.authorize({ ...lease }, undefined, signal))) throw new RootDenied()
    signal.throwIfAborted()
  }
  private async save(
    lease: ExecutionLease,
    checkpoint: Checkpoint,
    signal: AbortSignal,
    changes: StateChange[] = [],
  ): Promise<void> {
    await this.root(lease, signal)
    const rows = await this.options.state.commit(lease, [
      ...changes,
      {
        key: this.progressKey,
        expected: checkpoint.row.version,
        payload: json(checkpoint.value),
      },
    ])
    checkpoint.row = rows.find((row) => row.key === this.progressKey)!
  }
  private deadline(value: ReplayProgress): number {
    return Math.max(value.notBefore, Math.min(value.scan ? this.now() : value.scanAt, value.retryAt))
  }
  private async advance(lease: ExecutionLease, signal: AbortSignal): Promise<number> {
    let checkpoint: Checkpoint | undefined, operation: 'page' | 'retry' | undefined
    try {
      await this.root(lease, signal)
      let [row] = await this.options.state.read([this.progressKey])
      if (!row)
        [row] = await this.options.state.commit(lease, [
          { key: this.progressKey, expected: null, payload: json(initial(this.now())) },
        ])
      checkpoint = { row, value: progress(row, this.progressKey.slice(0, -'progress'.length)) }
      const value = checkpoint.value,
        now = this.now()
      if (value.notBefore > now) return value.notBefore
      if (!value.scan && value.scanAt <= now) {
        // Fresh state has no earlier polling checkpoint to lose.
        if (value.scanAt !== 0 && value.watermark < now - retention) {
          value.gaps = Math.min(Number.MAX_SAFE_INTEGER, value.gaps + 1)
          this.options.report(new Error('App delivery retention window advanced'), 'replay-retention-gap')
        }
        value.scan = {
          since: Math.max(0, value.watermark - minute, now - retention),
          started: now,
          cursor: null,
          seen: [],
          lastTime: null,
        }
        await this.save(lease, checkpoint, signal)
      }
      if (value.scan && (value.turn === 'page' || value.retryAt > now)) {
        operation = 'page'
        await this.page(lease, checkpoint, signal)
      } else if (value.retryAt <= now) {
        operation = 'retry'
        await this.retry(lease, checkpoint, signal)
      } else return this.deadline(value)
      if (value.failures || value.notBefore) {
        value.failures = value.notBefore = 0
        await this.save(lease, checkpoint, signal)
      }
      return this.deadline(value)
    } catch (error) {
      if (signal.aborted) return this.now()
      if (
        checkpoint &&
        !(
          error instanceof LeaseLost ||
          error instanceof StateCorrupt ||
          error instanceof StateConflict ||
          error instanceof RootDenied
        )
      ) {
        const value = checkpoint.value
        if (
          operation === 'page' &&
          (error instanceof ScanRestart ||
            error instanceof DeliveryPaginationError ||
            (value.scan?.cursor && error instanceof GitHubRequestError && [400, 404, 422].includes(error.status ?? 0)))
        ) {
          value.scan = null
          value.scanAt = this.now() + minute
          value.gaps = Math.min(Number.MAX_SAFE_INTEGER, value.gaps + 1)
        }
        value.failures = Math.min(32, value.failures + 1)
        value.notBefore = Math.max(
          this.now() + Math.min(interval, minute * 2 ** Math.min(value.failures - 1, 3)),
          error instanceof GitHubRequestError ? (error.retryAt ?? 0) : 0,
        )
        try {
          await this.save(lease, checkpoint, signal)
        } catch (failure) {
          if (!(failure instanceof LeaseLost)) this.options.report(failure, 'replay-state')
        }
      }
      this.options.report(error, 'replay-' + (operation ?? 'state'))
      return Math.max(this.now() + minute, checkpoint?.value.notBefore ?? 0)
    }
  }
  private async page(lease: ExecutionLease, checkpoint: Checkpoint, signal: AbortSignal): Promise<void> {
    const value = checkpoint.value,
      scan = value.scan!
    const current = hash(scan.cursor)
    if (scan.seen.length >= 10000 || scan.seen.includes(current))
      throw new ScanRestart('App delivery cursor repeated or exceeded limit')
    await this.root(lease, signal)
    const page = structuredClone(await this.options.app().deliveryPage(scan.cursor ?? undefined, signal))
    signal.throwIfAborted()
    let last = scan.lastTime
    for (const delivery of page.deliveries) {
      if ((last !== null && delivery.deliveredAt > last) || delivery.deliveredAt > this.now() + minute)
        throw new ScanRestart('App delivery ordering changed')
      last = delivery.deliveredAt
    }
    const ended = !page.cursor || page.deliveries.some((delivery) => delivery.deliveredAt < scan.since)
    if (!ended && (hash(page.cursor) === current || scan.seen.includes(hash(page.cursor))))
      throw new ScanRestart('App delivery cursor cycle')
    const candidates = page.deliveries
      .filter((delivery) => delivery.deliveredAt >= scan.since)
      .flatMap((delivery) => {
        const selected = candidate(delivery)
        return selected
          ? [
              {
                delivery: selected,
                success: delivery.statusCode !== null && delivery.statusCode >= 200 && delivery.statusCode < 300,
              },
            ]
          : []
      })
    const keys = [...new Set(candidates.map(({ delivery }) => this.itemPrefix + delivery.guid))]
    const previous = new Map((keys.length ? await this.options.state.read(keys) : []).map((row) => [row.key, row]))
    const values = new Map<string, ReplayItem>()
    for (const entry of candidates) {
      const key = this.itemPrefix + entry.delivery.guid,
        prior = previous.get(key)
      values.set(
        key,
        merge(values.get(key) ?? (prior ? item(prior, this.itemPrefix) : undefined), entry.delivery, entry.success),
      )
    }
    if (values.size) {
      await this.root(lease, signal)
      await this.options.state.commit(
        lease,
        [...values].map(([key, payload]) => ({
          key,
          expected: previous.get(key)?.version ?? null,
          payload: json(payload),
        })),
      )
    }
    // A crash here safely repeats the same page; no cursor is published before all items are durable.
    signal.throwIfAborted()
    if (ended) {
      value.watermark = Math.max(value.watermark, scan.started)
      value.scan = null
      value.scanAt = this.now() + interval
    } else {
      scan.seen.push(current)
      scan.cursor = page.cursor
      scan.lastTime = last
    }
    value.retryAt = Math.min(value.retryAt, this.now())
    value.turn = 'retry'
    await this.save(lease, checkpoint, signal)
  }
  private async retry(lease: ExecutionLease, checkpoint: Checkpoint, signal: AbortSignal): Promise<void> {
    const value = checkpoint.value
    const rows = await this.options.state.scan(lease, { prefix: this.itemPrefix, after: value.retryAfter, limit: 99 })
    const decoded = rows.map((row) => ({ row, value: item(row, this.itemPrefix) }))
    const keys = decoded.filter(({ value }) => !value.done).map(({ value }) => 'receipt/' + value.delivery.guid)
    const receipts = new Map((keys.length ? await this.options.state.read(keys) : []).map((row) => [row.key, row]))
    let changes: StateChange[] = []
    value.turn = 'page'
    for (const entry of decoded) {
      signal.throwIfAborted()
      const row = entry.row,
        pending = entry.value,
        receipt = receipts.get('receipt/' + pending.delivery.guid)
      value.retryAfter = row.key
      if (receipt) {
        if (
          !object(receipt.payload) ||
          receipt.payload.event !== pending.delivery.event ||
          typeof receipt.payload.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(receipt.payload.digest)
        )
          throw new StateCorrupt()
        pending.done = true
      }
      if (pending.expiresAt <= this.now()) {
        if (!pending.done) {
          value.gaps = Math.min(Number.MAX_SAFE_INTEGER, value.gaps + 1)
          this.options.report(
            new Error('App delivery expired without confirmation'),
            'replay-expired/' + pending.delivery.guid,
          )
        }
        changes.push({ key: row.key, expected: row.version })
      } else if (pending.done) {
        if (!item(row, this.itemPrefix).done)
          changes.push({ key: row.key, expected: row.version, payload: json(pending) })
      } else if (pending.nextAt <= this.now()) {
        if (!(await this.options.authorize({ ...lease }, pending.delivery.installation, signal))) {
          pending.nextAt = this.now() + minute
          changes.push({ key: row.key, expected: row.version, payload: json(pending) })
          await this.save(lease, checkpoint, signal, changes)
          changes = []
          continue
        }
        try {
          await this.options.app().redeliver(
            pending.delivery.id,
            async () => {
              if (!(await this.options.authorize({ ...lease }, pending.delivery.installation, signal)))
                throw new TargetDeferred()
              pending.intent = randomUUID()
              pending.attempts = Math.min(32, pending.attempts + 1)
              pending.nextAt = this.now() + interval
              await this.save(lease, checkpoint, signal, [
                ...changes,
                { key: row.key, expected: row.version, payload: json(pending) },
              ])
            },
            signal,
          )
        } catch (error) {
          if (error instanceof TargetDeferred) {
            pending.nextAt = this.now() + minute
            await this.save(lease, checkpoint, signal, [
              ...changes,
              { key: row.key, expected: row.version, payload: json(pending) },
            ])
          } else if (
            error instanceof GitHubRequestError &&
            [400, 404, 422].includes(error.status ?? 0) &&
            !error.retryAt
          )
            this.options.report(error, 'replay-request')
          else throw error
        }
        return
      }
    }
    if (rows.length < 99) {
      value.retryAfter = ''
      value.retryAt = this.now() + minute
    } else value.retryAt = this.now()
    await this.save(lease, checkpoint, signal, changes)
  }
}
