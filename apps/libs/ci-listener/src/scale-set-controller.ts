/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { CapacityPolicy } from './capacity'
import { AllocationRow, ExecutionJournal } from './execution/journal'
import { ExecutionScope, object, positive, retryCapacity, scopeKey } from './execution/model'
import { GitHubRequestError } from './github'
import { DEFAULT_RESOURCE_LABEL, selectRunnerLabels } from './resource-labels'
import { ScaleSetDiagnostics, ScaleSetEvent, ScaleSetFailure } from './scale-set-diagnostics'
import { ActionsScaleSets, isRequestIdText, ScaleSetRemoved, ScaleSetSession } from './scale-set-client'
import { LeaseLost, StateCorrupt, StateRecord } from './state/database'
import { ExecutionLease, ListenerState, StateChange, StateCheck } from './state/store'

/** One owner-wide limit for account setup and message processing. Network waits release their permit. */
export class ScaleSetWork {
  private active = 0
  private readonly staleLanes = new Set<object>()
  private refreshing = false
  private refreshAfter = 0
  deferStatistics(until: number): void {
    this.refreshAfter = Math.max(this.refreshAfter, until)
  }
  cancelStatisticsRefresh(lane: object): void {
    this.staleLanes.delete(lane)
  }
  async refreshStatistics<T>(lane: object, read: () => Promise<T>): Promise<T | undefined> {
    // Polls may return in the same order each time. Give each stale lane a turn.
    this.staleLanes.add(lane)
    if (this.refreshing || Date.now() < this.refreshAfter || this.staleLanes.values().next().value !== lane)
      return undefined
    this.staleLanes.delete(lane)
    this.refreshing = true
    try {
      return await read()
    } finally {
      this.refreshing = false
      this.deferStatistics(Date.now() + 5000)
    }
  }
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
  delivery: { covered: number; waitingForDispatch: boolean; offline: boolean; candidates?: Set<string>; spent?: number }
}
interface Lane {
  label: string
  target?: ScaleTarget
  task: Promise<void>
}
type AcquisitionPhase = 'requested' | 'accepted' | 'verify'
type PendingRequest = {
  id: string
  phase: AcquisitionPhase
}
interface SetRecord {
  name: string
  set: number | null
  assigned: number
  held: number
  pending: PendingRequest[]
  message: number | null
  session: string | null
}
// Limit outstanding acquisitions awaiting assignment, independently of running workers.
const acquisitionWindow = 1024
const statisticsIntervalMs = 50_000

// Assigned jobs can also be counted as acquired. Only the remainder can need a separate hold.
function unassignedAcquisitions(acquired: number | undefined, assigned: number): number {
  return acquired === undefined ? Infinity : Math.max(0, acquired - assigned)
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
    !(Number.isSafeInteger(v.held) && (v.held as number) >= 0) ||
    !(
      Array.isArray(v.pending) &&
      v.pending.length <= acquisitionWindow &&
      v.pending.every(
        (job): job is PendingRequest =>
          object(job) &&
          isRequestIdText(job.id) &&
          (job.phase === 'requested' || job.phase === 'accepted' || job.phase === 'verify'),
      ) &&
      new Set(v.pending.map((job) => job.id)).size === v.pending.length
    ) ||
    !(v.session == null || (typeof v.session === 'string' && /^[a-f\d-]{36}$/i.test(v.session))) ||
    !(v.message === null || (Number.isSafeInteger(v.message) && (v.message as number) >= 0))
  )
    throw new StateCorrupt()
  return {
    name: v.name,
    set: positive(v.set) ? v.set : null,
    assigned: v.assigned as number,
    held: v.held as number,
    pending: v.pending as SetRecord['pending'],
    message: v.message as number | null,
    session: typeof v.session === 'string' ? v.session : null,
  }
}
interface SetHost {
  service: ActionsScaleSets
  creationReady(label: string): boolean
  charged(id: number): number
  releaseSupply(row: AllocationRow): void
  authority(signal: AbortSignal): Promise<ReadonlySet<string>>
  policy(signal: AbortSignal): Promise<CapacityPolicy>
  observe?(event: ScaleSetEvent): void
  report(error: unknown, context: ScaleSetFailure): void
  wake(): void
}
export class ScaleSetController {
  private readonly stop = new AbortController()
  private readonly lanes = new Map<string, Lane>()
  private readonly confirmed = new Map<string, ScaleTarget>()
  private readonly persisted = new Set<string>()
  private readonly waiting = new Map<string, number>()
  private readonly cooling = new Map<string, NodeJS.Timeout>()
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
    if (this.signal.aborted) return []
    const active: ScaleTarget[] = []
    for (const [label, target] of this.confirmed) {
      const { offline, covered, waitingForDispatch, candidates } = target.delivery
      if (offline && covered >= target.assigned && !waitingForDispatch) {
        // A durable release can reopen uncovered demand without another poll.
        if (!candidates?.size) this.confirmed.delete(label)
      } else active.push(target)
    }
    return active
  }
  async restore(): Promise<void> {
    const occupied: string[] = [],
      idle: string[] = []
    let after = ''
    for (;;) {
      const page = await this.state.scan(this.lease, { prefix: this.prefix, after, limit: 100 })
      for (const row of page) {
        const record = readRecord(row)
        const list = record.held || record.assigned ? occupied : idle
        const label = row.key.slice(this.prefix.length)
        list.push(label)
        this.persisted.add(label)
      }
      if (page.length < 100) break
      after = page[page.length - 1].key
    }
    for (const label of [...occupied, DEFAULT_RESOURCE_LABEL, ...idle]) this.watch(label)
  }
  watch(label: string, failures = 0) {
    if (this.lanes.has(label) || this.waiting.has(label) || this.cooling.has(label) || this.signal.aborted) return
    this.waiting.set(label, failures)
    this.openNext()
  }
  private openNext() {
    if (this.signal.aborted || this.lanes.size >= 64) return
    const next = this.waiting.entries().next()
    if (next.done) return
    const [label, failures] = next.value
    this.waiting.delete(label)
    const selection = selectRunnerLabels([label], this.labels)
    if (!selection) throw new StateCorrupt()
    const lane: Lane = { label, task: Promise.resolve() }
    this.lanes.set(label, lane)
    const log = new ScaleSetDiagnostics(
      {
        scope: scopeKey(this.scope),
        organization: this.scope.organization,
        installation: this.scope.installation.id,
        label,
        scaleSet: null,
        messageId: null,
      },
      this.host.observe,
    )
    lane.task = this.listen(lane, [...selection.labels], failures, log)
      .then((rotate) => {
        if (rotate) {
          this.confirmed.delete(label)
          if (!this.signal.aborted) this.waiting.set(label, 0)
        }
      })
      .catch((error) => {
        if (!this.signal.aborted) this.host.report(error, log.failure(error))
      })
      .finally(() => {
        this.lanes.delete(label)
        this.openNext()
      })
  }
  private retryAfter(label: string, deadline: number, failures: number) {
    const schedule = () => {
      if (this.signal.aborted) return
      const wait = Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647))
      this.cooling.set(
        label,
        setTimeout(() => {
          if (Date.now() < deadline) return schedule()
          this.cooling.delete(label)
          this.watch(label, failures)
        }, wait),
      )
    }
    schedule()
  }
  async close() {
    this.stop.abort()
    this.confirmed.clear()
    for (const timer of this.cooling.values()) clearTimeout(timer)
    this.cooling.clear()
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
      this.host.releaseSupply(absent)
    }
  }
  private async retrySlots(id: number, assigned: number, held: number) {
    const key = scopeKey(this.scope)
    const { activity } = await this.journal.scope(this.lease, key)
    let after = '',
      allocated = 0,
      reserved = 0
    do {
      const page = await this.journal.workers(this.lease, key, after)
      for (const { value } of page.rows) {
        if (value.supply?.scaleSet !== id) continue
        const capacity = retryCapacity(value)
        if (capacity !== 'unavailable') allocated++
        if (capacity === 'reserved') reserved++
      }
      after = page.after
    } while (after && (allocated < assigned + held || reserved < held))
    return {
      available: Math.min(reserved, Math.max(0, allocated - assigned)),
      activity,
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
  private async registration(key: string): Promise<StateRecord> {
    let [row] = await this.state.read([key], this.lease)
    if (!row)
      [row] = await this.state.commit(this.lease, [
        {
          key,
          expected: null,
          payload: {
            name: 'boxlite-' + randomUUID().replaceAll('-', ''),
            set: null,
            assigned: 0,
            held: 0,
            pending: [],
            message: null,
          },
        },
      ])
    return row
  }
  async observe(label: string): Promise<void> {
    if (!this.persisted.has(label)) {
      await this.registration(this.prefix + label)
      this.persisted.add(label)
    }
    this.watch(label)
  }
  private async start(key: string, labels: string[], signal: AbortSignal, log: ScaleSetDiagnostics) {
    await log.during('authority', () => this.host.authority(signal))
    let row = await this.registration(key)
    const previous = readRecord(row)
    const group = this.scope.runners.kind === 'repository' ? 1 : this.scope.runners.group
    log.context.scaleSet = previous.set
    let set
    try {
      set = await log.during('resolve', () =>
        this.host.service.resolve(previous.name, group, labels, signal, previous.set ?? undefined),
      )
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
              held: 0,
              pending: [],
              message: null,
              session: null,
            },
          },
        ])
      }
      throw error
    }
    log.context.scaleSet = set.id
    if (previous.set !== null && previous.set !== set.id) throw new Error('Original scale set identity changed')
    if (!previous.set)
      [row] = await this.state.commit(this.lease, [
        { key, expected: row.version, payload: { ...previous, set: set.id } },
      ])
    await this.journal.check(this.lease)
    const session = await log.during('open', () => this.host.service.open(set.id, this.lease.owner, signal))
    return { row, session, id: set.id }
  }
  private async listen(lane: Lane, labels: string[], failures: number, log: ScaleSetDiagnostics) {
    const signal = this.signal,
      key = this.prefix + lane.label
    if (signal.aborted) return false
    let session: ScaleSetSession | undefined
    let retryAt = 0
    let readingOptionalStatistics = false
    try {
      const start = await this.work.run(signal, () => this.start(key, labels, signal, log))
      session = start.session
      log.emit({ event: 'ci-scale-set-session-opened', assigned: session.initial, acquired: session.initialAcquired })
      let row = start.row
      const previous = readRecord(row)
      const pendingRequests = new Map(previous.pending.map(({ id, phase }) => [id, phase]))
      let freshStatistics = true
      const publish = (assigned: number, held: number, previous: SetRecord) => {
        const delivery = !freshStatistics && lane.target?.assigned === assigned ? lane.target.delivery : undefined
        lane.target = {
          id: start.id,
          labels,
          assigned,
          held,
          check: { key, version: row.version },
          delivery: delivery ?? {
            covered: 0,
            waitingForDispatch:
              assigned > 0 || held > 0 || previous.assigned > 0 || previous.held > 0 || this.host.charged(start.id) > 0,
            offline: false,
          },
        }
        freshStatistics = false
        this.confirmed.set(lane.label, lane.target)
        this.host.wake()
      }
      const save = async (
        assigned: number,
        message: number | null,
        origin: string | null,
        held: number,
        checks?: readonly StateCheck[],
        retryActivity?: StateRecord,
      ) => {
        const old = readRecord(row)
        const pending = Array.from(pendingRequests, ([id, phase]) => ({ id, phase }))
        if (
          checks ||
          old.pending.length !== pending.length ||
          old.pending.some(({ id, phase }) => pendingRequests.get(id) !== phase) ||
          old.held !== held ||
          old.assigned !== assigned ||
          old.message !== message ||
          old.session !== origin
        ) {
          const changes: StateChange[] = [
            { key, expected: row.version, payload: { ...old, assigned, held, pending, message, session: origin } },
          ]
          // Lock the set before its scope, the same order as Box admission.
          if (retryActivity)
            changes.push({ key: retryActivity.key, expected: retryActivity.version, payload: retryActivity.payload })
          const saved = await log.during('persist-target', () => this.state.commit(this.lease, changes, checks))
          row = saved.find((record) => record.key === key)!
        } else await this.journal.check(this.lease)
        publish(assigned, held, old)
      }
      let assignedVerifiedAt = Date.now()
      const readStatistics = async () => {
        const result = await log.during('statistics', () => this.host.service.currentStatistics(start.id, signal))
        assignedVerifiedAt = Date.now()
        freshStatistics = true
        this.work.cancelStatisticsRefresh(lane)
        return result
      }
      let verifyAfter = 0
      const verifyAcquisitions = async (assigned: number, held: number, idle = false) => {
        const uncertain = [...pendingRequests].filter(([, phase]) => phase === 'verify')
        if (!uncertain.length && !idle) return { assigned, held }
        const current = await readStatistics()
        verifyAfter = assignedVerifiedAt + statisticsIntervalMs
        // Confirmed requests already account for part of the service total. An
        // assigned job may be one of them, so only deduct the guaranteed overlap.
        const confirmed = [...pendingRequests.values()].filter((phase) => phase === 'accepted').length
        const knownWaiting = Math.max(0, confirmed - current.assigned)
        const possible =
          current.acquired === undefined
            ? uncertain.length
            : Math.min(uncertain.length, Math.max(0, current.acquired - knownWaiting))
        const candidates = pendingRequests.size - uncertain.length + possible
        // Keep ambiguous IDs while any could be owned. Their shared reservation
        // follows the count without guessing which individual request succeeded.
        if (current.acquired === 0 && current.assigned === 0) for (const [id] of uncertain) pendingRequests.delete(id)
        const increase = Math.max(0, current.assigned - assigned)
        const retained = Math.min(
          candidates,
          Math.max(0, held - increase),
          idle ? unassignedAcquisitions(current.acquired, current.assigned) : Infinity,
        )
        if (idle && retained > 0 && retained < pendingRequests.size && current.acquired !== undefined) {
          for (const id of pendingRequests.keys()) pendingRequests.set(id, 'verify')
        }
        const released = held - retained - increase
        if (released > 0)
          await this.withdrawCanceled(start.id, released, current.assigned + retained, lane.target!.check)
        if (!retained) pendingRequests.clear()
        return { assigned: current.assigned, held: retained }
      }
      // New-session statistics cover all previous phases, including identities
      // already ambiguous after an earlier reconnect. Assigned jobs have their own target.
      const increase = Math.max(0, session.initial - previous.assigned)
      const acquired = session.initialAcquired
      const carried = Math.min(
        pendingRequests.size,
        Math.max(0, previous.held - increase),
        unassignedAcquisitions(acquired, session.initial),
      )
      if (!carried) pendingRequests.clear()
      else if (acquired !== undefined && carried < pendingRequests.size) {
        // The service reports a count, not which requests survived the disconnect.
        for (const id of pendingRequests.keys()) pendingRequests.set(id, 'verify')
      }
      await this.work.run(signal, async () => {
        const released = previous.held - carried - increase
        if (released > 0)
          await this.withdrawCanceled(start.id, released, start.session.initial + carried, {
            key,
            version: row.version,
          })
        await save(start.session.initial, previous.message, previous.session, carried)
      })
      let last: number | undefined
      while (!signal.aborted) {
        log.context.messageId = null
        const capacity = await log.during('capacity', () =>
          this.work.run(signal, async () => {
            const policy = await this.host.policy(signal)
            const free = await this.journal.remainingCapacity(this.lease, scopeKey(this.scope), policy)
            const limits = policy.limits.flatMap((limit) => (limit.maximum === null ? [] : [limit.maximum]))
            return Math.min(2_147_483_647, free + this.host.charged(start.id), ...limits)
          }),
        )
        log.emit({ event: 'ci-scale-set-poll-started', capacity })
        const message = await log.during('poll', () => start.session.poll(capacity, last, signal))
        log.context.messageId = message?.id ?? null
        if (message)
          log.emit({
            event: 'ci-scale-set-message-received',
            offered: message.available.length,
            capacity,
            assigned: message.assigned,
            held: lane.target!.held,
          })
        failures = 0
        // On reconnect a lost acquire may never be redelivered. Compare any
        // missing request with service statistics, keeping explicit reoffers charged.
        const offered = new Set(message?.available.map((job) => String(job.id)))
        let missing = false
        for (const [id, phase] of pendingRequests) {
          if (phase !== 'requested' || offered.has(id)) continue
          pendingRequests.set(id, 'verify')
          missing = true
        }
        if (message?.assigned !== undefined) {
          assignedVerifiedAt = Date.now()
          freshStatistics = true
          this.work.cancelStatisticsRefresh(lane)
        }
        let refreshedAssigned: number | undefined
        const idleWithHolds = !message && lane.target!.held > 0
        if (
          idleWithHolds ||
          ([...pendingRequests.values()].includes('verify') && (missing || Date.now() >= verifyAfter))
        ) {
          await this.work.run(signal, async () => {
            const target = lane.target!
            const next = await verifyAcquisitions(target.assigned, target.held, idleWithHolds)
            refreshedAssigned = next.assigned
            const prior = readRecord(row)
            await save(next.assigned, prior.message, prior.session, next.held)
          })
        } else if (lane.target!.assigned > 0 && Date.now() - assignedVerifiedAt >= statisticsIntervalMs) {
          await this.work.run(signal, async () => {
            const current = await this.work.refreshStatistics(lane, async () => {
              readingOptionalStatistics = true
              const statistics = await readStatistics()
              readingOptionalStatistics = false
              return statistics
            })
            if (!current) return
            refreshedAssigned = current.assigned
            if (!message) {
              const prior = readRecord(row)
              if (current.assigned === prior.assigned) publish(current.assigned, prior.held, prior)
              else await save(current.assigned, prior.message, prior.session, prior.held)
            }
          })
        }
        if (!message) {
          if (this.waiting.size && !lane.target!.held && !lane.target!.assigned && !this.host.charged(start.id))
            return true
          continue
        }
        await this.work.run(signal, async () => {
          // A crash after acquisition can leave a message with pre-acquisition statistics.
          // Resolve a conflicting first delivery against the current set before acquiring again.
          let assigned = refreshedAssigned ?? message.assigned ?? lane.target!.assigned
          if (refreshedAssigned === undefined && last === undefined && assigned !== lane.target!.assigned)
            assigned = (await readStatistics()).assigned
          // Statistics can account for an assignment before its ID arrives. Removing
          // that ID narrows the pending candidates without consuming a second hold.
          for (const id of message.settledRequests) pendingRequests.delete(String(id))
          let held = Math.min(
            pendingRequests.size,
            Math.max(0, lane.target!.held - Math.max(0, assigned - lane.target!.assigned)),
          )
          if (!held) pendingRequests.clear()
          const canceled = lane.target!.held - held - Math.max(0, assigned - lane.target!.assigned)
          if (canceled > 0) await this.withdrawCanceled(start.id, canceled, assigned + held, lane.target!.check)
          if (message.available.length && (capacity > assigned || held) && this.host.creationReady(lane.label)) {
            const authorized = await log.during('authority', () => this.host.authority(signal))
            const eligible = message.available.filter(
              (job) =>
                job.owner.toLowerCase() === this.scope.installation.account.login &&
                authorized.has(job.repository.toLowerCase()) &&
                selectRunnerLabels(job.labels, this.labels)?.label === lane.label,
            )
            if (!eligible.length) log.emit({ event: 'ci-scale-set-offers-skipped', reason: 'no-match' })
            const offers = [...new Map(eligible.map((job) => [String(job.id), job.id])).values()]
            const existing = new Set(pendingRequests.keys())
            const unresolved = offers.filter(
              (id) => existing.has(String(id)) && pendingRequests.get(String(id)) !== 'accepted',
            )
            const novel = offers.filter((id) => !existing.has(String(id))).slice(0, acquisitionWindow - existing.size)
            // When several candidates share fewer holds, none can spend another
            // candidate's slot. A redelivery needs a fresh quota CAS in that case.
            let covered = held === existing.size
            if (covered && unresolved.length) {
              const slots = await this.retrySlots(start.id, assigned, held)
              held = Math.min(held, slots.available)
              covered = held === existing.size
              if (covered) {
                const policy = await this.host.policy(signal)
                if (await this.journal.permitsChargedRetry(this.lease, scopeKey(this.scope), policy)) {
                  const prior = readRecord(row)
                  await save(assigned, prior.message, prior.session, held, policy.checks ?? [], slots.activity)
                  const accepted = await log.during('acquire', () => start.session.acquire(unresolved, signal))
                  log.emit({ event: 'ci-scale-set-acquired', attempted: unresolved.length, accepted: accepted.length })
                  for (const id of unresolved) pendingRequests.set(String(id), 'verify')
                  for (const id of accepted) pendingRequests.set(String(id), 'accepted')
                  if (accepted.length !== unresolved.length) {
                    const next = await verifyAcquisitions(assigned, held)
                    assigned = next.assigned
                    held = next.held
                  }
                }
              }
            }
            const needReservation = covered ? novel : [...unresolved, ...novel]
            const free = Math.max(0, capacity - assigned - held)
            const ids = needReservation.slice(0, free)
            if (ids.length) {
              const policy = await log.during('capacity', () => this.offerPolicy(start.id, assigned + held, signal))
              const prior = readRecord(row)
              // Invalidate older plans before reserving. The pool holds these slots
              // without dispatching a Box until Actions reports assigned demand.
              await save(assigned, prior.message, prior.session, held + ids.length)
              let reserved = 0
              while (reserved < ids.length && this.host.creationReady(lane.label)) {
                signal.throwIfAborted()
                const allocation = await log.during('reserve', () =>
                  this.journal.reserve(
                    this.lease,
                    scopeKey(this.scope),
                    null,
                    {
                      ...policy,
                      checks: [...(policy.checks ?? []), { key, version: row.version }],
                    },
                    { labels, scaleSet: start.id },
                  ),
                )
                if (!allocation) {
                  log.emit({ event: 'ci-scale-set-offers-skipped', reason: 'no-slot' })
                  break
                }
                if (!reserved) log.emit({ event: 'ci-scale-set-first-reservation', allocation: allocation.record.key })
                reserved++
              }
              if (reserved && this.host.creationReady(lane.label)) {
                const offered = ids.slice(0, reserved)
                for (const id of offered) pendingRequests.set(String(id), 'requested')
                await save(assigned, prior.message, prior.session, held + reserved)
                const accepted = await log.during('acquire', () => start.session.acquire(offered, signal))
                log.emit({ event: 'ci-scale-set-acquired', attempted: offered.length, accepted: accepted.length })
                let reconcile = false
                const confirmed = new Set(accepted.map(String))
                for (const request of offered) {
                  const id = String(request)
                  if (confirmed.has(id)) pendingRequests.set(id, 'accepted')
                  else if (existing.has(id)) {
                    pendingRequests.set(id, 'verify')
                    reconcile = true
                  } else pendingRequests.delete(id)
                }
                held = Math.min(pendingRequests.size, held + accepted.length)
                if (reconcile) {
                  const next = await verifyAcquisitions(assigned, held)
                  assigned = next.assigned
                  held = next.held
                }
              }
            }
          } else if (message.available.length) {
            log.emit({
              event: 'ci-scale-set-offers-skipped',
              reason: capacity > assigned || held ? 'creation-backoff' : 'capacity',
            })
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
          await log.during('ack', () => start.session.ack(message.id, signal))
          last = message.id
        })
      }
    } catch (error) {
      const failure = log.failure(error)
      const optionalReadUnavailable =
        readingOptionalStatistics &&
        error instanceof GitHubRequestError &&
        (error.status === undefined || error.status >= 500 || error.status === 429 || error.retryAt !== undefined)
      if (error instanceof GitHubRequestError && error.rateLimited && error.retryAt !== undefined)
        this.work.deferStatistics(error.retryAt)
      if (
        signal.aborted ||
        error instanceof LeaseLost ||
        error instanceof StateCorrupt ||
        error instanceof ScaleSetRemoved ||
        failure.stage === 'authority' ||
        (lane.target && failure.stage !== 'poll' && !optionalReadUnavailable)
      ) {
        this.confirmed.delete(lane.label)
      } else if (lane.target) {
        // An unsuccessful read carries no new assignment. The planner owns the unserved part of the last observation.
        lane.target.delivery.offline = true
      }
      if (signal.aborted) return false
      if (!(error instanceof LeaseLost || error instanceof StateCorrupt)) {
        failures++
        const deadline = error instanceof GitHubRequestError ? (error.retryAt ?? 0) : 0
        const backoff = Math.min(60_000, 1000 * 2 ** Math.min(6, failures - 1))
        retryAt = Math.max(deadline, Date.now() + backoff) + Math.floor(Math.random() * 500)
        failure.retryAt = retryAt
      }
      this.host.report(error, failure)
    } finally {
      this.work.cancelStatisticsRefresh(lane)
      if (session)
        try {
          await session.close()
        } catch (error) {
          this.host.report(error, log.failure(error, 'close'))
        }
    }
    if (retryAt) this.retryAfter(lane.label, retryAt, failures)
    return false
  }
}
