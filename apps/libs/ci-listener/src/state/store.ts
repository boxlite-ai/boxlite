/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { Json, LeaseLost, StateConflict, StateCorrupt, StateDatabase, StateRecord, StateTransaction } from './database'
import { RepositoryScanQueue } from '../compensation/queue'

export interface ExecutionLease {
  namespace: string
  owner: string
  epoch: number
}
export interface StateChange {
  key: string
  expected: string | null
  /** Undefined deletes an existing version; null is a persistable JSON value. */
  payload?: Json
}
export interface StateCheck {
  key: string
  version: string
}
type Owner = { owner: string; epoch: number; until: number }
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const record = (key: string, payload: Json): StateRecord => ({ key, payload, schema: 1, version: randomUUID() })

/** Durable facts only. Hosts authorize ingress; a lease fences execution commits, not already-issued HTTP requests. */
export class ListenerState {
  scans(): RepositoryScanQueue {
    return new RepositoryScanQueue(this.database, this.namespace, (tx, lease) => this.assertLease(tx, lease))
  }
  constructor(
    private readonly database: StateDatabase,
    private readonly namespace: string,
  ) {
    if (!/^[A-Za-z0-9:._/-]{1,200}$/.test(namespace)) throw new Error('Invalid Listener namespace')
  }

  async initialize(initial: { key: string; payload: Json }[] = []): Promise<void> {
    const seeds = initial.length ? this.prepare(initial.map((row) => ({ ...row, expected: null }))) : []
    await this.database.transaction(
      this.namespace,
      async (tx) => {
        const anchor = await tx.get('@anchor'),
          owner = await tx.get('@owner', true)
        if (anchor || owner) {
          this.anchor(anchor)
          this.owner(owner)
          for (const seed of seeds) this.valid(await tx.get(seed.key))
          return
        }
        if ((await tx.page('', 1)).length) throw new StateCorrupt()
        if (!(await tx.put(record('@anchor', { namespace: this.namespace }), null))) throw new StateConflict()
        if (!(await tx.put(record('@owner', { owner: '', epoch: 0, until: 0 }), null))) throw new StateConflict()
        if (seeds.length) await this.apply(tx, seeds)
      },
      'bootstrap',
    )
  }

  async acquire(ownerId: string, ttlMs: number): Promise<ExecutionLease | undefined> {
    this.ttl(ttlMs)
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) throw new Error('Invalid Listener owner')
    return this.database.transaction(this.namespace, async (tx) => {
      this.anchor(await tx.get('@anchor'))
      const row = await tx.get('@owner', true),
        previous = this.owner(row),
        now = await tx.now()
      if (previous.until > now) return undefined
      if (previous.epoch === Number.MAX_SAFE_INTEGER) throw new StateCorrupt()
      const next = { owner: ownerId, epoch: previous.epoch + 1, until: now + ttlMs }
      if (!(await tx.put(record('@owner', next), row!.version))) throw new StateConflict()
      return { namespace: this.namespace, owner: next.owner, epoch: next.epoch }
    })
  }

  async renew(lease: ExecutionLease, ttlMs: number): Promise<void> {
    lease = { ...lease }
    this.ttl(ttlMs)
    await this.database.transaction(this.namespace, async (tx) => {
      const row = await this.assertLease(tx, lease),
        current = this.owner(row)
      current.until = (await tx.now()) + ttlMs
      if (!(await tx.put(record('@owner', current), row.version))) throw new StateConflict()
    })
  }

  /** A complete database snapshot, not a series of independently committed page reads. */
  async recover(lease: ExecutionLease, maximum = 10_000, prefixes: readonly string[] = []): Promise<StateRecord[]> {
    lease = { ...lease }
    prefixes = [...prefixes]
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) throw new Error('Invalid recovery limit')
    for (const prefix of prefixes)
      if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,382}\/$/.test(prefix)) throw new Error('Invalid Listener record prefix')
    return this.database.transaction(
      this.namespace,
      async (tx) => {
        await this.assertLease(tx, lease)
        const records = new Map<string, StateRecord>()
        for (const prefix of prefixes.length ? prefixes : ['']) {
          let after = ''
          for (;;) {
            const rows = await tx.page(after, 100, prefix)
            for (const row of rows) {
              this.valid(row)
              if (!row.key.startsWith('@')) records.set(row.key, row)
            }
            if (records.size > maximum) throw new StateCorrupt()
            if (rows.length < 100) break
            after = rows[rows.length - 1].key
          }
        }
        await this.assertLease(tx, lease)
        return [...records.values()]
      },
      'snapshot',
    )
  }

  /** One bounded metadata page; this is not a complete recovery snapshot. */
  async scan(lease: ExecutionLease, range: { prefix: string; after?: string; limit?: number }): Promise<StateRecord[]> {
    lease = { ...lease }
    const { prefix, after = '', limit = 100 } = { ...range }
    if (
      !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,382}\/$/.test(prefix) ||
      (after !== '' && (!after.startsWith(prefix) || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,383}$/.test(after))) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Invalid Listener metadata scan')
    return this.database.transaction(
      this.namespace,
      async (tx) => {
        await this.assertLease(tx, lease)
        const rows = await tx.page(after, limit, prefix)
        if (rows.length > limit) throw new StateCorrupt()
        let previous = after
        for (const row of rows) {
          this.valid(row)
          if (!row.key.startsWith(prefix) || row.key <= previous) throw new StateCorrupt()
          previous = row.key
        }
        await this.assertLease(tx, lease)
        return rows
      },
      'snapshot',
    )
  }

  async commit(
    lease: ExecutionLease,
    changes: StateChange[],
    checks: readonly StateCheck[] = [],
  ): Promise<StateRecord[]> {
    lease = { ...lease }
    const prepared = this.prepare(changes)
    if (!Array.isArray(checks) || checks.length > 100) throw new Error('Invalid Listener state checks')
    const fences = checks.map(({ key, version }) => ({ key, version }))
    if (
      new Set(fences.map((check) => check.key)).size !== fences.length ||
      fences.some((check) => !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,383}$/.test(check.key) || !uuid.test(check.version))
    )
      throw new Error('Invalid Listener state checks')
    return this.database.transaction(this.namespace, async (tx) => {
      await this.assertLease(tx, lease)
      // Hold policy rows through admission without changing their versions.
      for (const check of fences.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
        const row = await tx.get(check.key, true)
        this.valid(row)
        if (row!.version !== check.version) throw new StateConflict()
      }
      const result = await this.apply(tx, prepared)
      // Waiting for another record can consume a lease after its first check.
      await this.assertLease(tx, lease)
      return result
    })
  }

  /** Point lookup, optionally fenced by an execution lease. Writes still require a conditional batch. */
  async read(keys: readonly string[], lease?: ExecutionLease): Promise<StateRecord[]> {
    keys = [...keys]
    lease = lease ? { ...lease } : undefined
    if (
      !keys.length ||
      keys.length > 100 ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,383}$/.test(key))
    )
      throw new Error('Invalid Listener lookup keys')
    return this.database.transaction(
      this.namespace,
      async (tx) => {
        if (lease) await this.assertLease(tx, lease)
        this.anchor(await tx.get('@anchor'))
        this.owner(await tx.get('@owner'))
        const rows: StateRecord[] = []
        for (const key of keys) {
          const row = await tx.get(key)
          if (row) {
            this.valid(row)
            rows.push(row)
          }
        }
        if (lease) await this.assertLease(tx, lease)
        return rows
      },
      'snapshot',
    )
  }

  /** Host adapters must check the live binding in this same database transaction. */
  async ingest(changes: StateChange[]): Promise<StateRecord[]> {
    const prepared = this.prepare(changes)
    if (prepared.some(({ key }) => !/^(receipt|notice|wake)\//.test(key)))
      throw new Error('Invalid ingress record kind')
    return this.database.transaction(this.namespace, async (tx) => {
      this.anchor(await tx.get('@anchor'))
      this.owner(await tx.get('@owner'))
      return this.apply(tx, prepared)
    })
  }

  private async apply(tx: StateTransaction, changes: StateChange[]): Promise<StateRecord[]> {
    const result: StateRecord[] = []
    for (const change of changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      if (change.payload === undefined) {
        if (!change.expected || !(await tx.remove(change.key, change.expected))) throw new StateConflict()
      } else {
        const next = record(change.key, change.payload)
        if (!(await tx.put(next, change.expected))) throw new StateConflict()
        result.push(next)
      }
    }
    return result
  }

  private async assertLease(tx: StateTransaction, lease: ExecutionLease): Promise<StateRecord> {
    if (lease.namespace !== this.namespace) throw new LeaseLost()
    this.anchor(await tx.get('@anchor'))
    const row = await tx.get('@owner', true),
      current = this.owner(row)
    if (current.owner !== lease.owner || current.epoch !== lease.epoch || current.until <= (await tx.now()))
      throw new LeaseLost()
    return row!
  }

  private anchor(row?: StateRecord): void {
    this.valid(row)
    if (
      !row!.payload ||
      typeof row!.payload !== 'object' ||
      Array.isArray(row!.payload) ||
      row!.payload.namespace !== this.namespace
    )
      throw new StateCorrupt()
  }
  private owner(row?: StateRecord): Owner {
    this.valid(row)
    const value = row!.payload as Owner | null
    if (
      !value ||
      typeof value.owner !== 'string' ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 0 ||
      !Number.isSafeInteger(value.until) ||
      value.until < 0
    )
      throw new StateCorrupt()
    return value
  }
  private valid(row?: StateRecord): void {
    if (!row || row.schema !== 1 || !uuid.test(row.version)) throw new StateCorrupt()
  }

  private prepare(changes: StateChange[]): StateChange[] {
    if (!changes.length || changes.length > 100 || new Set(changes.map((c) => c.key)).size !== changes.length)
      throw new Error('Invalid Listener state batch')
    let bytes = 0
    return changes.map((change) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,383}$/.test(change.key)) throw new Error('Invalid Listener state key')
      if (change.expected !== null && !uuid.test(change.expected)) throw new Error('Invalid Listener state version')
      if (change.payload === undefined) {
        if (!change.expected || change.key.startsWith('scope/'))
          throw new Error('Cannot remove permanent or absent state')
        return { key: change.key, expected: change.expected }
      }
      // Snapshot caller-owned objects before the first await; reject lossy JSON conversions.
      const text = JSON.stringify(change.payload, (_key, value) => {
        if (
          value === undefined ||
          typeof value === 'function' ||
          typeof value === 'symbol' ||
          (typeof value === 'number' && !Number.isFinite(value))
        )
          throw new Error('Invalid Listener JSON value')
        return value
      })
      const size = Buffer.byteLength(text)
      bytes += size
      if (size > 1_048_576 || bytes > 4_194_304) throw new Error('Listener state exceeds size limit')
      return { key: change.key, expected: change.expected, payload: JSON.parse(text) as Json }
    })
  }
  private ttl(value: number): void {
    if (!Number.isSafeInteger(value) || value < 100 || value > 300_000)
      throw new Error('Invalid Listener lease duration')
  }
}
