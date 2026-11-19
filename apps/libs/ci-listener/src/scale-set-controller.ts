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
  held: number
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
  held: number
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
    !(v.held === undefined || (Number.isSafeInteger(v.held) && (v.held as number) >= 0)) ||
    !(v.session == null || (typeof v.session === 'string' && /^[a-f\d-]{36}$/i.test(v.session))) ||
    !(v.message === null || (Number.isSafeInteger(v.message) && (v.message as number) >= 0))
  )
    throw new StateCorrupt()
  return {
    name: v.name,
    set: positive(v.set) ? v.set : null,
    assigned: v.assigned as number,
    held: (v.held as number | undefined) ?? 0,
    message: v.message as number | null,
    session: typeof v.session === 'string' ? v.session : null,
  }
}
interface SetHost {
  service: ActionsScaleSets
  creationReady(label: string): boolean
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
  private async drainRemoved(id: number) {
    let after = '',
      active = false
    do {
      const page = await this.journal.workers(this.lease, scopeKey(this.scope), after)
      for (const row of page.rows) {
        if (row.value.supply?.scaleSet !== id) continue
        active = true
        // A runner that never received a JIT cannot have taken a job. In-flight
        // delivery and running jobs keep their original identity and normal recovery.
        if (!row.value.closing && row.value.delivery === 'none')
          await this.journal.advance(this.lease, row.record.key, row.record.version, { closing: true })
      }
      after = page.after
    } while (after)
    if (active) this.host.wake()
    return !active
  }
  private async withdrawCanceled(id: number, canceled: number, target: number, check: StateCheck) {
    let after = '',
      charged = 0
    const candidates: { key: string; version: string }[] = []
    do {
      const page = await this.journal.workers(this.lease, scopeKey(this.scope), after)
      for (const row of page.rows) {
        if (row.value.supply?.scaleSet !== id || row.value.closing || row.value.box.phase === 'absent') continue
        charged++
        if (
          candidates.length < canceled &&
          row.value.box.phase === 'none' &&
          row.value.runner.phase === 'none' &&
          !row.value.effect
        )
          candidates.push(row.record)
      }
      after = page.after
    } while (after)
    for (const candidate of candidates.slice(0, Math.max(0, charged - target))) {
      // No external side effect was dispatched. The allocation CAS races safely
      // with the Box-create intent, and the target fence protects newer demand.
      const absent = await this.journal.advance(
        this.lease,
        candidate.key,
        candidate.version,
        {
          closing: true,
          box: { phase: 'absent', id: null },
          runner: { phase: 'absent', id: null },
        },
        [check],
      )
      await this.journal.release(this.lease, candidate.key, absent.record.version)
    }
  }
  private async offerPolicy(id: number, outstanding: number, signal: AbortSignal): Promise<CapacityPolicy> {
    const policy = await this.host.policy(signal)
    // Already assigned work has first claim on shared quota even if its Box
    // reservation has not committed yet. Apply that margin at the quota CAS.
    let after = ''
    while (outstanding > 0) {
      const page = await this.journal.workers(this.lease, scopeKey(this.scope), after)
      for (const row of page.rows) {
        if (row.value.supply?.scaleSet === id && !row.value.closing && row.value.box.phase !== 'absent') outstanding--
      }
      if (!page.after) break
      after = page.after
    }
    if (outstanding <= 0) return policy
    return {
      ...policy,
      limits: policy.limits.map((limit) => ({
        ...limit,
        maximum: limit.maximum === null ? null : Math.max(0, limit.maximum - outstanding),
      })),
    }
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
      if (error instanceof ScaleSetRemoved && previous.set && (await this.drainRemoved(previous.set))) {
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
        const save = async (assigned: number, message: number | null, origin: string | null, held = 0) => {
          const old = readRecord(row)
          if (old.held !== held || old.assigned !== assigned || old.message !== message || old.session !== origin) {
            ;[row] = await this.state.commit(this.lease, [
              { key, expected: row.version, payload: { ...old, assigned, held, message, session: origin } },
            ])
          } else await this.journal.check(this.lease)
          lane.target = { id: start.id, labels, assigned, held, check: { key, version: row.version } }
          this.host.wake()
        }
        const previous = readRecord(row)
        await this.work.run(signal, () => save(start.session.initial, previous.message, previous.session))
        const pendingRequests = new Set<string>()
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
          if (!message) {
            if (lane.target!.held) {
              const previous = readRecord(row)
              pendingRequests.clear()
              await this.work.run(signal, async () =>
                save(await this.host.service.currentAssigned(start.id, signal), previous.message, previous.session),
              )
            }
            continue
          }
          await this.work.run(signal, async () => {
            // A crash after acquisition can leave a message with pre-acquisition statistics.
            // Resolve a conflicting first delivery against the current set before acquiring again.
            let assigned = message.assigned ?? lane.target!.assigned
            if (last === undefined && assigned !== lane.target!.assigned)
              assigned = await this.host.service.currentAssigned(start.id, signal)
            // Assignment and cancellation can occur between two equal statistics samples.
            // Count an explicitly settled request once even when multiple events name it.
            for (const id of message.settledRequests) pendingRequests.delete(String(id))
            let held = Math.min(
              pendingRequests.size,
              Math.max(0, lane.target!.held - Math.max(0, assigned - lane.target!.assigned)),
            )
            if (!held) pendingRequests.clear()
            const canceled = lane.target!.held - held - Math.max(0, assigned - lane.target!.assigned)
            if (canceled > 0) await this.withdrawCanceled(start.id, canceled, assigned + held, lane.target!.check)
            const free = Math.max(0, capacity - assigned - held)
            if (message.available.length && free && this.host.creationReady(lane.label)) {
              const authorized = await this.host.authority(signal)
              const ids = message.available
                .filter(
                  (job) =>
                    !pendingRequests.has(String(job.id)) &&
                    job.owner.toLowerCase() === this.scope.installation.account.login &&
                    authorized.has(job.repository.toLowerCase()) &&
                    selectRunnerLabels(job.labels, this.labels)?.label === lane.label,
                )
                .slice(0, free)
                .map((job) => job.id)
              if (ids.length) {
                const policy = await this.offerPolicy(start.id, assigned + held, signal)
                const prior = readRecord(row)
                // Invalidate older plans before reserving. The pool holds these slots
                // without dispatching a Box until Actions reports assigned demand.
                await save(assigned, prior.message, prior.session, held + ids.length)
                let reserved = 0
                while (reserved < ids.length && this.host.creationReady(lane.label)) {
                  signal.throwIfAborted()
                  const allocation = await this.journal.reserve(
                    this.lease,
                    scopeKey(this.scope),
                    null,
                    {
                      ...policy,
                      checks: [...(policy.checks ?? []), { key, version: row.version }],
                    },
                    { labels, scaleSet: start.id },
                  )
                  if (!allocation) break
                  reserved++
                }
                if (reserved && this.host.creationReady(lane.label)) {
                  const accepted = await start.session.acquire(ids.slice(0, reserved), signal)
                  for (const id of accepted) pendingRequests.add(String(id))
                  held += accepted.length
                }
              }
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
            await save(assigned, message.id, start.session.id, held)
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
