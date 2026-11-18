/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { parallelReads } from './parallel-reads'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionJournal } from './execution/journal'
import { decodeScope, ExecutionScope, object, positive, scopeKey } from './execution/model'
import { DiscoveryRequest, DiscoverySnapshot } from './directory'
import { PoolBackend, PoolSettings, WorkerEvent, WorkerPool } from './execution/pool'
import { JobNotice, jobMatches, WorkflowJob } from './jobs'
import { LeaseLost, StateConflict, StateCorrupt, StateRecord } from './state/database'
import { ExecutionLease, ListenerState, StateCheck } from './state/store'
import { FairSelection, matches, pendingJob, repositories } from './scheduling'
import { VerifiedWebhook } from './webhook'
import type { AppDeliveryRecovery } from './replay/recovery'
import { CapacityPolicy, CapacityProvider, captureCapacity, closedCapacity } from './capacity'
import { RepositoryCompensation, RepositoryScanSession } from './compensation/scanner'
import { ScanClaim } from './compensation/queue'
import { decodeDemand, DemandUncertain, LabelDemand, rebuildQueueSnapshot } from './demand'
import { CredentialCollector } from './credential-retirement'
import { WorkQueue } from './execution/work-queue'
import { NotifiedDemand } from './notified-demand'

export interface ListenerBackend extends PoolBackend {
  pending?(notices: readonly JobNotice[], signal?: AbortSignal): Promise<WorkflowJob[]>
  reader?(): Pick<ListenerBackend, 'queued' | 'pending' | 'close'>
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
interface QueueProof {
  demands: StateRecord[]
  check: StateCheck
}
interface Session {
  verifying: WorkQueue
  verifiedAt: Map<string, { revision: string; until: number }>
  repairing: WorkQueue
  snapshots: Map<string, QueueProof>
  observed: Map<string, string>
  positive: NotifiedDemand
  planning: WorkQueue
  planningAfter: number
  execution: WorkQueue
  demandRefresh: Map<string, number>
  demandRetryAt: Map<string, number>
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
  private readonly failedReaders = new Map<string, Pick<ListenerBackend, 'queued' | 'pending' | 'close'>>()
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
    let scans: Promise<PromiseSettledResult<void>> | undefined
    let superseded = false
    let retirement: Promise<void> | undefined
    const retireDeployment = () => {
      superseded = true
      scanStop.abort()
      return (retirement ??= this.drain(signal))
    }
    try {
      while (!signal.aborted) {
        try {
          await this.journal.initialize()
          if (await this.options.state.superseded()) {
            superseded = true
            break
          }
          // Observe scan failures while in-flight execution still owns this session.
          scans ??= Promise.allSettled([this.compensation.run(AbortSignal.any([signal, scanStop.signal]))]).then(
            ([result]) => result,
          )
          await this.retireKnown()
          const lease = await this.options.state.acquire(randomUUID(), this.timing.leaseMs)
          if (lease) await this.session(lease, signal, retireDeployment)
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
          // A pending scan must not delay retirement of independent owners.
          const closing = retirement ?? this.drain(signal)
          const [, scan] = await Promise.all([Promise.allSettled([closing]), scans])
          if (scan?.status === 'rejected') this.options.host.report(scan.reason, 'compensation-retirement')
          await closing
          // A scan may return a reader after the first drain has finished.
          await this.drain(signal)
        } else {
          await scans?.then((scan) => {
            if (scan.status === 'rejected') throw scan.reason
          })
        }
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
  private async session(
    lease: ExecutionLease,
    external: AbortSignal,
    retireDeployment: () => Promise<void>,
  ): Promise<void> {
    const stop = new AbortController(),
      signal = AbortSignal.any([external, stop.signal]),
      report = (operation: string) => (error: unknown) => {
        if (error instanceof LeaseLost && !signal.aborted) {
          renewalError = error
          stop.abort()
        }
        if (!signal.aborted || error instanceof LeaseLost) this.options.host.report(error, operation)
      },
      session: Session = {
        verifying: new WorkQueue(8, report('job-verification')),
        verifiedAt: new Map(),
        repairing: new WorkQueue(2, report('queue-reconciliation')),
        snapshots: new Map(),
        observed: new Map(),
        positive: new NotifiedDemand(this.options.state, lease, this.worker.labels),
        planning: new WorkQueue(8, report('label-capacity-balance')),
        planningAfter: 0,
        execution: new WorkQueue(32, report('allocation-work')),
        demandRefresh: new Map(),
        demandRetryAt: new Map(),
        lease,
        recoveryAfter: '',
        runtimes: new Map(),
        current: new Map(),
        discoveryAt: 0,
        discoveryPending: false,
        jobs: new FairSelection(),
      }
    let renewalError: unknown, failure: unknown
    let failed = false
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
    } catch (error) {
      failure = error
      failed = true
    } finally {
      stop.abort()
      await renewal
      for (const runtime of session.runtimes.values()) this.retiring.add(runtime)
      const results = await Promise.allSettled([
        session.verifying.close().then(() => this.retireReaders()),
        session.repairing.close().then(() => this.retireReaders()),
        session.planning.close(),
        session.execution.close(),
        this.retireSession(retireDeployment),
      ])
      const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
      if (failures.length) {
        if (failed) failures.unshift(failure)
        failure =
          failures.length === 1 ? failures[0] : new AggregateError(failures, 'Listener work retirement is incomplete')
        failed = true
      }
    }
    if (failed) throw failure
  }
  private async retireSession(retireDeployment: () => Promise<void>): Promise<void> {
    let superseded: boolean
    try {
      superseded = await this.options.state.superseded()
    } catch (error) {
      try {
        await this.retireKnown()
      } catch (retirement) {
        throw new AggregateError([error, retirement], 'Listener retirement and deployment observation failed')
      }
      throw error
    }
    if (superseded) await retireDeployment()
    else await this.retireKnown()
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
    try {
      await this.retireReaders()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, 'Listener credential retirement is incomplete')
  }
  private async retireReaders(): Promise<void> {
    for (const [key, reader] of this.failedReaders) {
      await reader.close()
      if (this.failedReaders.get(key) === reader) this.failedReaders.delete(key)
    }
  }
  private async readWithSession(
    id: string,
    backend: ListenerBackend,
    read: (reader: Pick<ListenerBackend, 'queued' | 'pending' | 'close'>) => Promise<void>,
  ): Promise<void> {
    const failed = this.failedReaders.get(id)
    if (failed) {
      await failed.close()
      this.failedReaders.delete(id)
    }
    const reader = backend.reader?.() ?? {
      queued: backend.queued.bind(backend),
      pending: backend.pending?.bind(backend),
      close: async () => {},
    }
    let failure: unknown,
      rejected = false
    try {
      await read(reader)
    } catch (error) {
      failure = error
      rejected = true
    }
    try {
      await reader.close()
    } catch (error) {
      this.failedReaders.set(id, reader)
      failure = rejected ? new AggregateError([failure, error], 'CI read and credential retirement failed') : error
      rejected = true
    }
    if (rejected) throw failure
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
          { queue: session.execution, wake: () => this.wake?.() },
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
        // Validate durable membership before admitting new bindings; execution remains asynchronous.
        await this.journal.workers(lease, key)
        // Recovery consumes an existing reservation, even when policy lookup is unavailable.
        session.planning.enqueue(key, row.record.version, () =>
          runtime.pool.tick(lease, closedCapacity, undefined, signal),
        )
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
      session.planning.enqueue(key, job.record.version, async () => {
        signal.throwIfAborted()
        const policy = await resolveCapacity(scope, job.notice.repository, job.notice)
        if (!(await this.journal.hasCapacity(lease, key, policy))) return
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
      })
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
    const revision = JSON.stringify(records.map((row) => [row.key, row.version]))
    const pending = records.filter((row) => row.key.startsWith('notice/')).map(pendingJob)
    const chosen = session.jobs.take(
      pending.flatMap((job) =>
        [...runtimes]
          .filter(([key, { scope }]) => session.current.has(key) && matches(scope, job))
          .map(([key, { scope }]) => ({ scope, value: { key, job } })),
      ),
      32,
    )
    const groups = new Map<string, { key: string; scope: ExecutionScope; runtime: Runtime; notices: typeof pending }>()
    for (const { key, job } of chosen) {
      const { scope, runtime } = runtimes.get(key)!
      const id = `${key}/${job.notice.repository}/${job.notice.run}`
      const group = groups.get(id) ?? { key, scope, runtime, notices: [] }
      group.notices.push(job)
      groups.set(id, group)
    }
    for (const [id, group] of groups) {
      const revision = JSON.stringify(group.notices.map((job) => [job.record.key, job.record.version]))
      const verified = session.verifiedAt.get(id)
      if (verified?.revision === revision && verified.until > Date.now()) continue
      session.verifying.enqueue(id, revision, async () => {
        signal.throwIfAborted()
        const backend = group.runtime.backend
        const verification = { revision, until: 0 }
        session.verifiedAt.set(id, verification)
        let observations: WorkflowJob[] = []
        const checkedAt = Date.now()
        await this.readWithSession(id, backend, async (reader) => {
          await session.positive.read(
            group.scope,
            group.notices.map((job) => job.notice),
            async (jobs) => {
              const pending = reader?.pending?.bind(reader) ?? backend.pending?.bind(backend)
              observations = pending ? await pending(jobs, signal) : []
              if (!pending) for (const job of jobs) observations.push(await backend.job(job, signal))
              signal.throwIfAborted()
              return observations
            },
          )
          for (const job of observations.filter((job) => job.status !== 'queued' || job.runner !== null)) {
            const notice = group.notices.find((notice) => notice.notice.job === job.job)
            if (notice) await this.settle(session.lease, notice.record)
          }
        })
        if (session.verifiedAt.get(id) !== verification) return
        verification.until = checkedAt + 30000
        if (session.verifiedAt.size > 4096) session.verifiedAt.delete(session.verifiedAt.keys().next().value!)
        this.wake?.()
      })
    }
    const entries = [...runtimes]
    for (let offset = 0; offset < entries.length; offset++) {
      const index = (session.planningAfter + offset) % entries.length
      const [key, { scope, runtime }] = entries[index]
      const accepted = session.planning.enqueue(key, revision, async () => {
        signal.throwIfAborted()
        const current = session.current.has(key),
          repos = repositories(scope)
        for (const row of records.filter((row) =>
          repos.some((repository) => row.key.startsWith(`demand/${scope.installation.id}/${repository}/`)),
        ))
          if (
            object(row.payload) &&
            positive(row.payload.accountId) &&
            row.payload.accountId !== scope.installation.account.id
          )
            throw new StateCorrupt()
        const notices = pending.filter((job) => matches(scope, job))
        const signature = JSON.stringify(notices.map((job) => [job.record.key, job.record.version]))
        const resolve = async (values: readonly LabelDemand[]) => {
          const target = values.find((value) => value.queued > 0)
          return target ? capacity(scope, target.repositoryId) : closedCapacity
        }
        if (current) this.reconcileScope(session, key, scope, runtime, signal)
        const snapshots = repos.map((repository) => session.snapshots.get(`${key}/${repository}`))
        const checks = snapshots.flatMap((snapshot) => (snapshot ? [snapshot.check] : []))
        const actual = new Map(
          (checks.length && checks.length <= 100
            ? await this.options.state.read(
                checks.map((check) => check.key),
                session.lease,
              )
            : []
          ).map((row) => [row.key, row.version]),
        )
        if (
          current &&
          checks.length === repos.length &&
          checks.every((check) => check.expiresAt! > Date.now() && actual.get(check.key) === check.version)
        ) {
          const demands = snapshots.flatMap((snapshot) =>
            snapshot!.demands.map((row) => ({ ...decodeDemand(row), expiresAt: snapshot!.check.expiresAt })),
          )
          await runtime.pool.balance(session.lease, await resolve(demands), demands, signal, true, checks)
          for (const repository of repos) session.snapshots.delete(`${key}/${repository}`)
          return
        }
        const values: LabelDemand[] = []
        if (current)
          for (const row of records.filter((row) =>
            repos.some((repository) => row.key.startsWith(`demand/${scope.installation.id}/${repository}/`)),
          )) {
            try {
              const demand = decodeDemand(row)
              if (demand.accountId !== scope.installation.account.id) throw new StateCorrupt()
              if (!demand.dirty) values.push(demand)
              else if (session.observed.get(row.key) !== row.version) {
                session.demandRefresh.delete(key)
                session.demandRetryAt.delete(key)
                this.reconcileScope(session, key, scope, runtime, signal, true)
                session.observed.set(row.key, row.version)
              }
            } catch (error) {
              if (
                object(row.payload) &&
                positive(row.payload.accountId) &&
                row.payload.accountId !== scope.installation.account.id
              )
                throw error
              this.reconcileScope(session, key, scope, runtime, signal, true)
            }
          }
        const fresh = current && notices.length > 0 && session.observed.get(key) !== signature
        if (!fresh) {
          try {
            await runtime.pool.balance(session.lease, await resolve(values), values, signal)
            return
          } catch (error) {
            if (!(error instanceof DemandUncertain) || !current) throw error
            if (error.requiresJobRefresh) {
              await this.invalidateVerification(session, key, scope)
              return
            }
            this.reconcileScope(session, key, scope, runtime, signal, true)
          }
        }
        if (!current) return
        const demands = await session.positive.read(scope, [], async () => [])
        if (!demands.length && values.some((value) => value.queued > 0)) {
          for (const id of session.verifiedAt.keys()) if (id.startsWith(key + '/')) session.verifiedAt.delete(id)
          return
        }
        try {
          await runtime.pool.balance(session.lease, await resolve(demands), demands, signal, 'positive')
        } catch (error) {
          if (!(error instanceof DemandUncertain) || !error.requiresJobRefresh) throw error
          await this.invalidateVerification(session, key, scope)
          return
        }
        session.observed.set(key, signature)
      })
      session.planningAfter = (index + 1) % entries.length
      if (!accepted) break
    }
  }
  private async invalidateVerification(session: Session, key: string, scope: ExecutionScope): Promise<void> {
    for (const repository of repositories(scope)) await session.positive.invalidate(scope.installation.id, repository)
    for (const id of session.verifiedAt.keys()) if (id.startsWith(key + '/')) session.verifiedAt.delete(id)
    this.wake?.()
  }
  private reconcileScope(
    session: Session,
    key: string,
    scope: ExecutionScope,
    runtime: Runtime,
    signal: AbortSignal,
    urgent = false,
  ): void {
    const previous = session.demandRefresh.get(key) ?? 0
    if (
      Date.now() < (session.demandRetryAt.get(key) ?? 0) ||
      Date.now() - previous < (urgent ? 30000 : this.timing.compensationMs)
    )
      return
    session.repairing.enqueue(key, String(previous), async () => {
      const repos = repositories(scope)
      const proofs = await parallelReads(
        repos,
        (repository, signal) => this.scanRepository(session, key, scope, runtime, repository, signal),
        signal,
        4,
      ).catch((error) => {
        // Back off a whole-cohort conflict so healthy repositories and admission can progress.
        if (error instanceof StateConflict)
          throw new AggregateError([error], 'Scope queue changed during reconciliation')
        throw error
      })
      const now = await this.options.state.now(session.lease)
      session.demandRefresh.set(key, Date.now())
      // Publish one cohort; an early completion retains its own deadline.
      if (repos.length <= 100 && proofs.every((proof) => proof.check.expiresAt! > now)) {
        for (const [index, repository] of repos.entries()) session.snapshots.set(`${key}/${repository}`, proofs[index])
        session.demandRetryAt.delete(key)
      } else {
        for (const repository of repos) session.snapshots.delete(`${key}/${repository}`)
        session.demandRetryAt.set(key, Date.now() + this.timing.compensationMs)
        const deferred = new DemandUncertain(
          repos.length > 100
            ? 'Surplus retirement deferred: scope exceeds the 100-check proof budget'
            : 'Surplus retirement deferred: scope scan exceeded the proof freshness window',
        )
        deferred.name = repos.length > 100 ? 'ScopeProofBudgetExceeded' : 'ScopeProofFreshnessExceeded'
        this.options.host.report(deferred, 'surplus-retirement-deferred')
      }
      this.wake?.()
    })
  }
  private async scanRepository(
    session: Session,
    key: string,
    scope: ExecutionScope,
    runtime: Runtime,
    repository: number,
    signal: AbortSignal,
  ): Promise<QueueProof> {
    const id = `${key}/${repository}`
    const prefix = `demand/${scope.installation.id}/${repository}/`,
      wakeKey = `wake/${scope.installation.id}/${repository}`,
      revisionKey = `queue-revision/${scope.installation.id}/${repository}`
    let proof: QueueProof | undefined
    await this.readWithSession(id, runtime.backend, async (reader) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const records = await this.options.state.recover(session.lease, 100000, [
          prefix,
          `notice/${scope.installation.id}/`,
        ])
        const before = new Map(
          (await this.options.state.read([wakeKey, revisionKey], session.lease)).map((row) => [row.key, row]),
        )
        const jobs = (await reader.queued(repository, signal)).filter((job) => jobMatches(job, this.worker.labels))
        signal.throwIfAborted()
        try {
          const snapshot = await rebuildQueueSnapshot(
            this.options.state,
            session.lease,
            {
              installationId: scope.installation.id,
              accountId: scope.installation.account.id,
              repositoryId: repository,
            },
            records.filter((row) => row.key.startsWith(prefix)),
            jobs,
            before.get(wakeKey)?.version,
            { version: before.get(revisionKey)?.version },
          )
          await session.positive.invalidate(scope.installation.id, repository)
          for (const id of session.verifiedAt.keys())
            if (id.startsWith(`${key}/${repository}/`)) session.verifiedAt.delete(id)
          proof = {
            demands: snapshot.demands,
            check: {
              key: snapshot.revision.key,
              version: snapshot.revision.version,
              expiresAt: (await this.options.state.now(session.lease)) + 30000,
            },
          }
          const queued = new Set(jobs.map((job) => job.job))
          for (const row of records.filter((row) => row.key.startsWith('notice/'))) {
            const notice = pendingJob(row)
            if (notice.notice.repository === repository && !queued.has(notice.notice.job))
              await this.settle(session.lease, row)
          }
          break
        } catch (error) {
          if (!(error instanceof StateConflict) || attempt === 1) throw error
        }
      }
    })
    return proof!
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
