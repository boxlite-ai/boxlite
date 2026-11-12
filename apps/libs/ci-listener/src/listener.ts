/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionJournal } from './execution/journal'
import { decodeScope, ExecutionScope, object, positive, scopeKey } from './execution/model'
import { DiscoveryRequest, DiscoverySnapshot } from './directory'
import { PoolBackend, PoolSettings, WorkerEvent, WorkerPool } from './execution/pool'
import { JobNotice, jobMatches, WorkflowJob } from './jobs'
import { LeaseLost, StateConflict, StateCorrupt, StateRecord } from './state/database'
import { ExecutionLease, ListenerState } from './state/store'
import { FairSelection, matches, pendingJob, repositories } from './scheduling'
import { VerifiedWebhook } from './webhook'
import type { AppDeliveryRecovery } from './replay/recovery'
import { CapacityPolicy, CapacityProvider, captureCapacity, closedCapacity } from './capacity'
import { RepositoryCompensation, RepositoryScanSession } from './compensation/scanner'
import { ScanClaim } from './compensation/queue'
import { decodeDemand, DemandUncertain, LabelDemand, rebuildDemand } from './demand'
import { CredentialCollector } from './credential-retirement'

export interface ListenerBackend extends PoolBackend {
  queued(repository: number, signal?: AbortSignal): Promise<WorkflowJob[]>
  close(): Promise<void>
}
export interface ListenerHost {
  readonly recovery?: Pick<AppDeliveryRecovery, 'step'>
  discover(lease: ExecutionLease, signal: AbortSignal, request: DiscoveryRequest): Promise<DiscoverySnapshot>
  backend(scope: ExecutionScope, lease: ExecutionLease): Promise<ListenerBackend>
  scan(claim: ScanClaim, signal: AbortSignal): Promise<RepositoryScanSession>
  /** Persist with live binding authorization in the same ingress transaction. */
  accept(notification: VerifiedWebhook): Promise<'stored' | 'duplicate'>
  report(error: unknown, operation: string): void
  observe?(event: WorkerEvent): void
  /** Permanently retire background discovery/replay and their local handles. */
  close?(): Promise<void>
}
interface Runtime {
  backend: ListenerBackend
  pool: WorkerPool
}
interface Session {
  demandRefresh: Map<string, number>
  lease: ExecutionLease
  recoveryAfter: string
  runtimes: Map<string, Runtime>
  current: Map<string, ExecutionScope>
  discoveryAt: number
  discoveryPending: boolean
  jobs: FairSelection
}
export interface ListenerOptions {
  state: ListenerState
  host: ListenerHost
  worker: PoolSettings
  capacity: CapacityProvider
  timing?: { tickMs?: number; leaseMs?: number; discoveryMs?: number; compensationMs?: number }
}

/** Same controller in both hosts. Host callbacks supply identity, not scheduling decisions. */
export class Listener {
  private readonly journal: ExecutionJournal
  private readonly worker: PoolSettings
  private readonly compensation: RepositoryCompensation
  private readonly credentials: CredentialCollector
  private readonly timing: { tickMs: number; leaseMs: number; discoveryMs: number; compensationMs: number }
  private running = false
  private readonly retiring = new Set<Runtime>()
  private wake?: () => void
  constructor(private readonly options: ListenerOptions) {
    this.journal = new ExecutionJournal(options.state)
    this.credentials = new CredentialCollector(options.state)
    this.worker = { ...options.worker, labels: [...options.worker.labels] }
    this.timing = { tickMs: 1000, leaseMs: 30000, discoveryMs: 300000, compensationMs: 300000, ...options.timing }
    if (
      Object.values(this.timing).some((value) => !positive(value)) ||
      this.timing.leaseMs < 300 ||
      this.timing.leaseMs > 300000
    )
      throw new Error('Invalid Listener scheduling configuration')
    this.compensation = new RepositoryCompensation({
      queue: options.state.scans(),
      open: (claim, signal) => options.host.scan(claim, signal),
      report: (error, operation) => options.host.report(error, operation),
      wake: () => this.wake?.(),
      tickMs: this.timing.tickMs,
      intervalMs: this.timing.compensationMs,
    })
  }
  async receive(notification: VerifiedWebhook): Promise<'stored' | 'duplicate'> {
    const captured = {
      ...notification,
      hint: { ...notification.hint, job: notification.hint.job ? { ...notification.hint.job } : null },
    }
    await this.journal.initialize()
    const result = await this.options.host.accept(captured)
    this.wake?.()
    return result
  }
  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error('Listener is already running')
    this.running = true
    const scanStop = new AbortController()
    let scans: Promise<void> | undefined
    let superseded = false
    try {
      while (!signal.aborted) {
        try {
          await this.journal.initialize()
          if (await this.options.state.superseded()) {
            superseded = true
            break
          }
          scans ??= this.compensation.run(AbortSignal.any([signal, scanStop.signal]))
          await this.retireKnown()
          const lease = await this.options.state.acquire(randomUUID(), this.timing.leaseMs)
          if (lease) await this.session(lease, signal)
        } catch (error) {
          if (signal.aborted && error instanceof AggregateError) throw error
          if (!signal.aborted) this.options.host.report(error, 'listener-session')
        }
        if (!signal.aborted) await this.wait(signal)
      }
    } finally {
      scanStop.abort()
      try {
        if (superseded) {
          // Failed scan retirement must not skip the other local owners.
          await scans?.catch((error) => this.options.host.report(error, 'compensation-retirement'))
          await this.drain(signal)
        } else await scans
      } finally {
        this.running = false
      }
    }
  }
  private async drain(signal: AbortSignal): Promise<void> {
    let backoff = this.timing.tickMs
    for (;;) {
      const results = await Promise.allSettled([
        this.retireKnown(),
        this.compensation.close(),
        this.options.host.close?.(),
      ])
      const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      if (!failures.length) return
      const error = new AggregateError(failures, 'Superseded Listener retirement remains pending')
      if (signal.aborted) throw error
      this.options.host.report(error, 'listener-retirement')
      try {
        await delay(backoff, undefined, { signal })
      } catch {
        throw error
      }
      backoff = Math.min(backoff * 2, 60000)
    }
  }
  private async session(lease: ExecutionLease, external: AbortSignal): Promise<void> {
    const stop = new AbortController(),
      signal = AbortSignal.any([external, stop.signal]),
      session: Session = {
        demandRefresh: new Map(),
        lease,
        recoveryAfter: '',
        runtimes: new Map(),
        current: new Map(),
        discoveryAt: 0,
        discoveryPending: false,
        jobs: new FairSelection(),
      }
    let renewalError: unknown
    const renewal = (async () => {
      try {
        while (!signal.aborted) {
          await delay(Math.floor(this.timing.leaseMs / 3), undefined, { signal })
          await this.options.state.renew(lease, this.timing.leaseMs)
        }
      } catch (error) {
        if (!signal.aborted) {
          renewalError = error
          stop.abort()
        }
      }
    })()
    try {
      while (!signal.aborted) {
        try {
          await this.cycle(session, signal)
          try {
            await this.credentials.step(lease)
          } catch (error) {
            if (error instanceof LeaseLost) throw error
            this.options.host.report(error, 'credential-collection')
          }
        } catch (error) {
          if (error instanceof LeaseLost) throw error
          if (!signal.aborted) this.options.host.report(error, 'listener-cycle')
        }
        if (!signal.aborted) await this.wait(signal)
      }
      if (renewalError) throw renewalError
    } finally {
      stop.abort()
      await renewal
      for (const runtime of session.runtimes.values()) this.retiring.add(runtime)
      await this.retireKnown()
    }
  }
  private async retireKnown(): Promise<void> {
    const failures: unknown[] = []
    // Failed handles survive the session; do not acquire a new lease before retirement succeeds.
    for (const runtime of this.retiring) {
      let retired = true
      try {
        await runtime.pool.close()
      } catch (error) {
        retired = false
        failures.push(error)
      }
      try {
        await runtime.backend.close()
      } catch (error) {
        retired = false
        failures.push(error)
      }
      if (retired) this.retiring.delete(runtime)
    }
    if (failures.length) throw new AggregateError(failures, 'Listener credential retirement is incomplete')
  }
  private async runtime(session: Session, key: string, scope: ExecutionScope): Promise<Runtime> {
    let runtime = session.runtimes.get(key)
    if (!runtime) {
      const backend = await this.options.host.backend(decodeScope(scope), { ...session.lease })
      runtime = {
        backend,
        pool: new WorkerPool(
          this.journal,
          key,
          async () => backend,
          this.worker,
          (event) => this.options.host.observe?.(event),
        ),
      }
      session.runtimes.set(key, runtime)
    }
    return runtime
  }
  private async cycle(session: Session, signal: AbortSignal): Promise<void> {
    const { lease } = session,
      recovery = await this.journal.activeScopes(lease, session.recoveryAfter),
      blocked = new Set<string>(),
      counted = new Map<string, { scope: ExecutionScope; runtime: Runtime }>()
    session.recoveryAfter = recovery.after
    // Only outstanding work is paged; each pool separately fences admission until
    // its worker recovery round completes without a blocking resource failure.
    for (const row of recovery.rows) {
      const key = row.record.key
      try {
        const runtime = await this.runtime(session, key, row.scope)
        if (runtime.backend.inventory) {
          counted.set(key, { scope: row.scope, runtime })
          continue
        }
        // Recovery consumes an existing reservation, even when policy lookup is unavailable.
        await (await this.runtime(session, key, row.scope)).pool.tick(lease, closedCapacity, undefined, signal)
      } catch (error) {
        if (error instanceof LeaseLost || error instanceof StateCorrupt) throw error
        blocked.add(key)
        this.options.host.report(error, 'worker-recovery')
      }
    }
    signal.throwIfAborted()
    this.options.host.recovery?.step(lease, signal)
    const records = await this.options.state.recover(lease, 100000, ['notice/', 'wake/', 'demand/'])
    const wakes = records.filter((row) => row.key.startsWith('wake/'))
    for (const row of wakes) this.validateWake(row)
    const inventory = wakes.filter((row) => {
        const hint = row.payload as { installationId: number; accountId: number; repositoryId: number }
        return (
          hint.repositoryId === 0 ||
          ![...session.current.values()].some(
            (scope) =>
              scope.installation.id === hint.installationId &&
              scope.installation.account.id === hint.accountId &&
              repositories(scope).includes(hint.repositoryId),
          )
        )
      }),
      refresh = Date.now() >= session.discoveryAt
    if (refresh || session.discoveryPending || inventory.length) {
      const discovery = await this.options.host.discover({ ...lease }, signal, {
          refresh,
          wakes: inventory.map((row) => {
            const hint = row.payload as { installationId: number; accountId: number; repositoryId: number }
            return {
              key: row.key,
              version: row.version,
              installationId: hint.installationId,
              accountId: hint.accountId,
              repositoryId: hint.repositoryId,
            }
          }),
        }),
        scopes: ExecutionScope[] = [],
        rejected = new Set<string>(),
        targets = new Map<string, string>(),
        next = new Map<string, ExecutionScope>()
      for (const definition of discovery.scopes) {
        try {
          scopes.push(decodeScope(definition))
        } catch (error) {
          if (typeof definition?.binding === 'string') rejected.add(definition.binding)
          this.options.host.report(error, 'scope-definition')
        }
      }
      for (const scope of scopes) {
        for (const repository of repositories(scope)) {
          const target = `${scope.installation.id}/${repository}`
          const previous = targets.get(target)
          if (previous !== undefined) {
            rejected.add(previous)
            rejected.add(scope.binding)
            this.options.host.report(
              new Error('Current CI scopes overlap an installation repository'),
              'scope-definition',
            )
          }
          targets.set(target, scope.binding)
        }
      }
      for (const scope of scopes) {
        if (rejected.has(scope.binding)) continue
        const key = scopeKey(scope)
        try {
          if (!session.current.has(key)) await this.journal.define(lease, scope)
          next.set(key, scope)
        } catch (error) {
          if (error instanceof LeaseLost || error instanceof StateCorrupt || error instanceof StateConflict) throw error
          rejected.add(scope.binding)
          this.options.host.report(error, 'scope-definition')
        }
      }
      for (const [key, scope] of next) if (rejected.has(scope.binding)) next.delete(key)
      session.current = next
      session.discoveryPending = discovery.pending
      if (refresh) session.discoveryAt = Date.now() + this.timing.discoveryMs
      for (const completed of discovery.completed) {
        const wake = inventory.find((row) => row.key === completed.key && row.version === completed.version)
        if (
          !wake ||
          !object(wake.payload) ||
          wake.payload.installationId !== completed.installationId ||
          wake.payload.accountId !== completed.accountId ||
          wake.payload.repositoryId !== completed.repositoryId
        )
          throw new StateCorrupt()
        await this.settle(lease, wake)
      }
    }
    const resolveCapacity = async (
      scope: ExecutionScope,
      repository: number,
      job?: JobNotice,
    ): Promise<CapacityPolicy> =>
      captureCapacity(
        await this.options.capacity.resolve({
          scope: decodeScope(scope),
          repository,
          job: job ? { ...job } : undefined,
          lease: { ...lease },
          signal,
        }),
      )
    for (const [key, scope] of session.current) {
      const runtime = await this.runtime(session, key, scope)
      if (runtime.backend.inventory) counted.set(key, { scope, runtime })
    }
    await this.balanceCounts(session, counted, records, resolveCapacity, signal)
    const pending = records.filter((row) => row.key.startsWith('notice/')).map(pendingJob),
      candidates = pending.flatMap((job) =>
        [...session.current]
          .filter(([key, scope]) => !counted.has(key) && !blocked.has(key) && matches(scope, job))
          .map(([key, scope]) => ({ scope, value: { key, scope, job } })),
      )
    for (const { key, scope, job } of session.jobs.take(candidates, 32)) {
      signal.throwIfAborted()
      try {
        const policy = await resolveCapacity(scope, job.notice.repository, job.notice)
        if (!(await this.journal.hasCapacity(lease, key, policy))) continue
        const runtime = await this.runtime(session, key, scope),
          current = await runtime.backend.job(job.notice, signal)
        if (
          current.repository !== job.notice.repository ||
          current.job !== job.notice.job ||
          current.run !== job.notice.run
        )
          throw new Error('Original CI notice identity changed')
        if (jobMatches(current, this.worker.labels)) await runtime.pool.tick(lease, policy, job.notice, signal)
        else await this.settle(lease, job.record)
      } catch (error) {
        if (error instanceof LeaseLost) throw error
        if (!signal.aborted) this.options.host.report(error, 'job-admission')
      }
    }
    signal.throwIfAborted()
    for (const wake of wakes)
      if (object(wake.payload) && positive(wake.payload.repositoryId)) {
        const hint = wake.payload
        if (
          [...session.current.values()].some(
            (scope) =>
              scope.installation.id === hint.installationId &&
              scope.installation.account.id === hint.accountId &&
              repositories(scope).includes(hint.repositoryId as number),
          )
        )
          await this.settle(lease, wake)
      }
    for (const [key, runtime] of session.runtimes) {
      if (session.current.has(key) || (await this.journal.scope(lease, key)).active) continue
      await runtime.pool.close()
      await runtime.backend.close()
      session.runtimes.delete(key)
    }
  }
  private async balanceCounts(
    session: Session,
    runtimes: Map<string, { scope: ExecutionScope; runtime: Runtime }>,
    records: readonly StateRecord[],
    capacity: (scope: ExecutionScope, repository: number, job?: JobNotice) => Promise<CapacityPolicy>,
    signal: AbortSignal,
  ): Promise<void> {
    const counters = new Map(records.filter((row) => row.key.startsWith('demand/')).map((row) => [row.key, row]))
    const tasks = [...runtimes].map(async ([key, { scope, runtime }]) => {
      const current = session.current.has(key)
      const related = (row: StateRecord) =>
        row.key.startsWith(`demand/${scope.installation.id}/`) &&
        repositories(scope).some((id) => row.key.startsWith(`demand/${scope.installation.id}/${id}/`))
      const notices = records.filter(
        (row) =>
          row.key.startsWith(`notice/${scope.installation.id}/`) &&
          object(row.payload) &&
          repositories(scope).includes(row.payload.repositoryId as number),
      )
      const repairs = new Set<number>()
      const now = Date.now()
      for (const row of [...counters.values()].filter(related)) {
        try {
          const value = decodeDemand(row)
          const refreshKey = `${scope.installation.id}/${value.repositoryId}`
          if (
            value.dirty ||
            (value.queued > 0 &&
              now - value.updatedAt >= 30000 &&
              now - (session.demandRefresh.get(refreshKey) ?? 0) >= 30000)
          )
            repairs.add(value.repositoryId)
        } catch {
          repairs.add(Number(row.key.split('/')[2]))
        }
      }
      for (const notice of notices)
        if (object(notice.payload) && notice.payload.counted !== true)
          repairs.add(notice.payload.repositoryId as number)
      const deferredRepositories = new Set<number>()
      const refreshCounts = async (targets: Iterable<number>) => {
        for (const repository of targets) {
          if (!repositories(scope).includes(repository)) throw new StateCorrupt()
          const prefix = `demand/${scope.installation.id}/${repository}/`
          for (let attempt = 0; attempt < 2; attempt++) {
            const wakeKey = `wake/${scope.installation.id}/${repository}`
            const [wake] = await this.options.state.read([wakeKey], session.lease)
            const jobs = (await runtime.backend.queued(repository, signal)).filter((job) =>
              jobMatches(job, this.worker.labels),
            )
            try {
              const refreshed = await rebuildDemand(
                this.options.state,
                session.lease,
                {
                  installationId: scope.installation.id,
                  accountId: scope.installation.account.id,
                  repositoryId: repository,
                },
                [...counters.values()].filter((row) => row.key.startsWith(prefix)),
                jobs,
                wake?.version,
              )
              for (const key of counters.keys()) if (key.startsWith(prefix)) counters.delete(key)
              for (const row of refreshed) counters.set(row.key, row)
              deferredRepositories.delete(repository)
              session.demandRefresh.set(`${scope.installation.id}/${repository}`, Date.now())
              break
            } catch (error) {
              if (!(error instanceof StateConflict)) throw error
              // A racing webhook invalidates this entire repository snapshot.
              // Never reserve from it; leave unsettled notices for the next cycle.
              for (const key of counters.keys()) if (key.startsWith(prefix)) counters.delete(key)
              if (attempt === 1) {
                deferredRepositories.add(repository)
                break
              }
              for (const row of await this.options.state.recover(session.lease, 100000, [prefix]))
                counters.set(row.key, row)
            }
          }
        }
      }
      if (current) await refreshCounts(repairs)
      const readCounts = (): LabelDemand[] => {
        const values = current ? [...counters.values()].filter(related).map(decodeDemand) : []
        if (values.some((value) => value.accountId !== scope.installation.account.id)) throw new StateCorrupt()
        return values
      }
      const resolve = async (values: readonly LabelDemand[]) => {
        const target = values.find((value) => value.queued > 0)
        return target ? capacity(scope, target.repositoryId) : closedCapacity
      }
      let demands = readCounts()
      try {
        await runtime.pool.balance(session.lease, await resolve(demands), demands, signal)
      } catch (error) {
        if (!(error instanceof DemandUncertain) || !current) throw error
        // PAT hosts and missed running events cannot derive a trustworthy deficit
        // from transport counters alone. Rebuild once before any resource mutation.
        await refreshCounts(repositories(scope))
        demands = readCounts()
        await runtime.pool.balance(session.lease, await resolve(demands), demands, signal, true)
      }
      for (const notice of current ? notices : [])
        if (object(notice.payload) && !deferredRepositories.has(notice.payload.repositoryId as number))
          await this.settle(session.lease, notice)
    })
    const results = await Promise.allSettled(tasks)
    for (const result of results)
      if (result.status === 'rejected') {
        if (result.reason instanceof LeaseLost || signal.aborted) throw result.reason
        this.options.host.report(result.reason, 'label-capacity-balance')
      }
  }
  private validateWake(row: StateRecord): void {
    const value = row.payload
    if (
      !object(value) ||
      !positive(value.installationId) ||
      !positive(value.accountId) ||
      !Number.isSafeInteger(value.repositoryId) ||
      (value.repositoryId as number) < 0 ||
      row.key !== `wake/${value.installationId}/${value.repositoryId}`
    )
      throw new StateCorrupt()
  }
  private async settle(lease: ExecutionLease, row: StateRecord): Promise<void> {
    try {
      await this.options.state.commit(lease, [{ key: row.key, expected: row.version }])
    } catch (error) {
      if (!(error instanceof StateConflict)) throw error
    }
  }
  private async wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const finish = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          if (this.wake === finish) this.wake = undefined
          resolve()
        },
        timer = setTimeout(finish, this.timing.tickMs)
      this.wake = finish
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }
}
