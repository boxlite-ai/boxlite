/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CapacityPolicy } from './capacity'
import { ExecutionJournal } from './execution/journal'
import { ExecutionScope, object, positive, scopeKey } from './execution/model'
import { GitHubRequestError } from './github'
import { parseResourceLabels, selectRunnerLabels } from './resource-labels'
import { ActionsScaleSets, ScaleSetRemoved, ScaleSetSession } from './scale-set-client'
import { LeaseLost, StateCorrupt, StateRecord } from './state/database'
import { ExecutionLease, ListenerState, StateCheck } from './state/store'

export type ScaleSetBindings = ReadonlyMap<string, readonly string[]>
export function scaleSetBindings(raw?: string): ScaleSetBindings {
  const bindings = new Map<string, string[]>()
  if (!raw) return bindings
  const values: unknown = JSON.parse(raw)
  if (!object(values)) throw new Error('CI_SCALE_SET_BINDINGS must map binding IDs to resource labels')
  for (const [binding, labels] of Object.entries(values)) {
    if (
      !/^(?:\*|[a-zA-Z0-9:._/-]{1,128})$/.test(binding) ||
      !Array.isArray(labels) ||
      !labels.length ||
      labels.length > 64 ||
      !labels.every((label) => typeof label === 'string' && parseResourceLabels([label])?.label === label) ||
      new Set(labels).size !== labels.length
    )
      throw new Error('Invalid CI scale set binding or resource labels')
    bindings.set(binding, labels)
  }
  return bindings
}

/** One owner-wide limit for account setup and message processing. Network waits release their permit. */
export class ScaleSetWork {
  private active = 0
  private readonly waiting: (() => void)[] = []
  constructor(private readonly limit = 8) {}
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve))
    else this.active++
    try {
      signal.throwIfAborted()
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}
export interface ScaleTarget {
  id: number
  labels: string[]
  assigned: number
  check: StateCheck
}
interface Lane {
  label: string
  target?: ScaleTarget
  task: Promise<void>
}
interface SetRecord {
  name: string
  set: number | null
  assigned: number
  message: number | null
  session: string | null
}
function readRecord(row: StateRecord): SetRecord {
  const v = row.payload
  if (
    row.schema !== 1 ||
    !object(v) ||
    typeof v.name !== 'string' ||
    !/^boxlite-[a-f0-9]{32}$/.test(v.name) ||
    !(v.set === null || positive(v.set)) ||
    !Number.isSafeInteger(v.assigned) ||
    (v.assigned as number) < 0 ||
    !(v.session == null || (typeof v.session === 'string' && /^[a-f\d-]{36}$/i.test(v.session))) ||
    !(v.message === null || (Number.isSafeInteger(v.message) && (v.message as number) >= 0))
  )
    throw new StateCorrupt()
  return {
    name: v.name,
    set: positive(v.set) ? v.set : null,
    assigned: v.assigned as number,
    message: v.message as number | null,
    session: typeof v.session === 'string' ? v.session : null,
  }
}
interface SetHost {
  service: ActionsScaleSets
  charged(id: number): number
  authority(signal: AbortSignal): Promise<ReadonlySet<string>>
  policy(signal: AbortSignal): Promise<CapacityPolicy>
  report(error: unknown): void
  wake(): void
}
export class ScaleSetController {
  private readonly stop = new AbortController()
  private readonly lanes = new Map<string, Lane>()
  private readonly prefix: string
  private readonly signal: AbortSignal
  constructor(
    private readonly state: ListenerState,
    private readonly lease: ExecutionLease,
    private readonly scope: ExecutionScope,
    private readonly labels: readonly string[],
    private readonly journal: ExecutionJournal,
    private readonly work: ScaleSetWork,
    private readonly host: SetHost,
    lifetime: AbortSignal,
  ) {
    this.prefix = 'scale-set/' + scopeKey(scope).slice(6) + '/'
    this.signal = AbortSignal.any([this.stop.signal, lifetime])
  }
  targets(): ScaleTarget[] {
    return [...this.lanes.values()].flatMap((lane) => (lane.target ? [lane.target] : []))
  }
  async restore(configured: readonly string[]): Promise<void> {
    const saved = await this.state.scan(this.lease, { prefix: this.prefix, after: '', limit: 65 })
    if (saved.length > 64) throw new StateCorrupt()
    for (const label of [...configured, ...saved.map((row) => row.key.slice(this.prefix.length))]) this.watch(label)
  }
  watch(label: string) {
    if (this.lanes.has(label) || this.lanes.size >= 64 || this.signal.aborted) return
    const selection = selectRunnerLabels([label], this.labels)
    if (!selection) throw new StateCorrupt()
    const lane: Lane = { label, task: Promise.resolve() }
    this.lanes.set(label, lane)
    lane.task = this.listen(lane, [...selection.labels]).catch((error) => {
      if (!this.signal.aborted) this.host.report(error)
    })
  }
  async close() {
    this.stop.abort()
    await Promise.all([...this.lanes.values()].map((lane) => lane.task))
  }
  private async canReplace(id: number) {
    let after = ''
    do {
      const page = await this.journal.workers(this.lease, scopeKey(this.scope), after)
      if (page.rows.some((row) => row.value.supply?.scaleSet === id)) return false
      after = page.after
    } while (after)
    return true
  }
  private async start(key: string, labels: string[], signal: AbortSignal) {
    await this.host.authority(signal)
    let [row] = await this.state.read([key], this.lease)
    if (!row)
      [row] = await this.state.commit(this.lease, [
        {
          key,
          expected: null,
          payload: { name: 'boxlite-' + randomUUID().replaceAll('-', ''), set: null, assigned: 0, message: null },
        },
      ])
    const previous = readRecord(row)
    const group = this.scope.runners.kind === 'repository' ? 1 : this.scope.runners.group
    let set
    try {
      set = await this.host.service.resolve(previous.name, group, labels, signal, previous.set ?? undefined)
    } catch (error) {
      if (error instanceof ScaleSetRemoved && previous.set && (await this.canReplace(previous.set))) {
        await this.state.commit(this.lease, [
          {
            key,
            expected: row.version,
            payload: {
              name: 'boxlite-' + randomUUID().replaceAll('-', ''),
              set: null,
              assigned: 0,
              message: null,
              session: null,
            },
          },
        ])
      }
      throw error
    }
    if (previous.set !== null && previous.set !== set.id) throw new Error('Original scale set identity changed')
    if (!previous.set)
      [row] = await this.state.commit(this.lease, [
        { key, expected: row.version, payload: { ...previous, set: set.id } },
      ])
    await this.journal.check(this.lease)
    const session = await this.host.service.open(set.id, this.lease.owner, signal)
    return { row, session, id: set.id }
  }
  private async listen(lane: Lane, labels: string[]) {
    const signal = this.signal,
      key = this.prefix + lane.label
    let failures = 0
    while (!signal.aborted) {
      let session: ScaleSetSession | undefined,
        retry = 0
      try {
        const start = await this.work.run(signal, () => this.start(key, labels, signal))
        session = start.session
        let row = start.row
        const save = async (assigned: number, message: number | null, origin: string | null) => {
          const old = readRecord(row)
          if (old.assigned !== assigned || old.message !== message || old.session !== origin) {
            ;[row] = await this.state.commit(this.lease, [
              { key, expected: row.version, payload: { ...old, assigned, message, session: origin } },
            ])
          } else await this.journal.check(this.lease)
          lane.target = { id: start.id, labels, assigned, check: { key, version: row.version } }
          this.host.wake()
        }
        const previous = readRecord(row)
        await this.work.run(signal, () => save(start.session.initial, previous.message, previous.session))
        let last: number | undefined
        while (!signal.aborted) {
          const capacity = await this.work.run(signal, async () => {
            const policy = await this.host.policy(signal)
            const free = await this.journal.remainingCapacity(this.lease, scopeKey(this.scope), policy)
            const limits = policy.limits.flatMap((limit) => (limit.maximum === null ? [] : [limit.maximum]))
            return Math.min(2_147_483_647, free + this.host.charged(start.id), ...limits)
          })
          const message = await session.poll(capacity, last, signal)
          failures = 0
          if (!message) continue
          await this.work.run(signal, async () => {
            // A crash after acquisition can leave a message with pre-acquisition statistics.
            // Resolve a conflicting first delivery against the current set before acquiring again.
            let assigned = message.assigned ?? lane.target!.assigned
            if (last === undefined && assigned !== lane.target!.assigned)
              assigned = await this.host.service.currentAssigned(start.id, signal)
            const free = Math.max(0, capacity - assigned)
            if (message.available.length && free) {
              const authorized = await this.host.authority(signal)
              const ids = message.available
                .filter(
                  (job) =>
                    job.owner.toLowerCase() === this.scope.installation.account.login &&
                    authorized.has(job.repository.toLowerCase()) &&
                    selectRunnerLabels(job.labels, this.labels)?.label === lane.label,
                )
                .slice(0, free)
                .map((job) => job.id)
              if (ids.length) await start.session.acquire(ids, signal)
            }
            for (const runner of message.worked) {
              const allocation = await this.journal.allocation(this.lease, 'worker/' + runner.name.slice(7))
              if (
                allocation &&
                allocation.value.scope === scopeKey(this.scope) &&
                allocation.value.supply?.scaleSet === start.id &&
                allocation.value.runner.id === runner.id &&
                allocation.value.runner.phase === 'known' &&
                !allocation.value.runner.worked
              ) {
                await this.journal.advance(this.lease, allocation.record.key, allocation.record.version, {
                  runner: { ...allocation.value.runner, worked: true },
                })
              }
            }
            await save(assigned, message.id, start.session.id)
            signal.throwIfAborted()
            await start.session.ack(message.id, signal)
            last = message.id
          })
        }
      } catch (error) {
        lane.target = undefined
        if (signal.aborted) return
        this.host.report(error)
        if (error instanceof LeaseLost || error instanceof StateCorrupt) return
        failures++
        const deadline = error instanceof GitHubRequestError ? (error.retryAt ?? 0) : 0
        const backoff = Math.min(60_000, 1000 * 2 ** Math.min(6, failures - 1))
        retry = Math.max(deadline - Date.now(), backoff) + Math.floor(Math.random() * 500)
      } finally {
        if (session)
          try {
            await session.close()
          } catch (error) {
            this.host.report(error)
          }
      }
      if (retry) await delay(Math.min(retry, 2_147_483_647), undefined, { signal })
    }
  }
}
