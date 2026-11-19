/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ScaleSetController, ScaleSetWork } from './scale-set-controller'
import { ActionsScaleSets } from './scale-set-client'
import { selectRunnerLabels } from './resource-labels'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionJournal } from './execution/journal'
import { decodeScope, ExecutionScope, object, positive, scopeKey } from './execution/model'
import { DiscoveryRequest, DiscoverySnapshot } from './directory'
import { PoolBackend, PoolSettings, WorkerEvent, WorkerPool } from './execution/pool'
import { LeaseLost, StateConflict, StateCorrupt, StateRecord } from './state/database'
import { ExecutionLease, ListenerState } from './state/store'
import { matches, pendingJob, repositories } from './scheduling'
import { VerifiedWebhook } from './webhook'
import type { AppDeliveryRecovery } from './replay/recovery'
import { CapacityProvider, captureCapacity, closedCapacity } from './capacity'
import { RepositoryCompensation, RepositoryScanSession } from './compensation/scanner'
import { ScanClaim } from './compensation/queue'
import { CredentialCollector } from './credential-retirement'
import { WorkQueue } from './execution/work-queue'

export interface ListenerBackend extends PoolBackend {
  readonly scaleSets: ActionsScaleSets
  scaleSetAuthority(signal: AbortSignal): Promise<ReadonlySet<string>>
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
  sets?: ScaleSetController
  backend: ListenerBackend
  pool: WorkerPool
}
interface Session {
  setWork: ScaleSetWork
  planning: WorkQueue
  execution: WorkQueue
  lease: ExecutionLease
  recoveryAfter: string
  runtimes: Map<string, Runtime>
  current: Map<string, ExecutionScope>
  discoveryAt: number
  discoveryPending: boolean
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
        setWork: new ScaleSetWork(),
        planning: new WorkQueue(8, report('label-capacity-balance')),
        execution: new WorkQueue(32, report('allocation-work')),
        lease,
        recoveryAfter: '',
        runtimes: new Map(),
        current: new Map(),
        discoveryAt: 0,
        discoveryPending: false,
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
          this.options.host.report(error, 'listener-renewal')
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
        await runtime.sets?.close()
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
          { queue: session.execution, wake: () => this.wake?.() },
        ),
      }
      session.runtimes.set(key, runtime)
    }
    return runtime
  }
  private async cycle(session: Session, signal: AbortSignal): Promise<void> {
    const { lease } = session
    const recovery = await this.journal.activeScopes(lease, session.recoveryAfter)
    session.recoveryAfter = recovery.after
    signal.throwIfAborted()
    this.options.host.recovery?.step(lease, signal)
    const records = await this.options.state.recover(lease, 100000, ['notice/', 'wake/'])
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
    const scopes = new Map(recovery.rows.map((row) => [row.record.key, row.scope]))
    const recovering = new Set(scopes.keys())
    for (const [key, scope] of session.current) scopes.set(key, scope)
    for (const [key, scope] of scopes) {
      signal.throwIfAborted()
      try {
        const runtime = await this.runtime(session, key, scope)
        await this.scheduleScaleSets(session, key, scope, runtime, records, signal, recovering.has(key))
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof LeaseLost || error instanceof StateCorrupt) throw error
        this.options.host.report(error, 'scope-backend')
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
      await runtime.sets?.close()
      await runtime.pool.close()
      await runtime.backend.close()
      session.runtimes.delete(key)
    }
  }
  private async scheduleScaleSets(
    session: Session,
    key: string,
    scope: ExecutionScope,
    runtime: Runtime,
    records: readonly StateRecord[],
    signal: AbortSignal,
    recovering: boolean,
  ) {
    const current = session.current.has(key)
    const policy = (signal: AbortSignal) => this.options.capacity.resolve({ scope, lease: session.lease, signal })
    if (current && !runtime.sets) {
      const backend = runtime.backend
      const controller = new ScaleSetController(
        this.options.state,
        session.lease,
        scope,
        this.worker.labels,
        this.journal,
        session.setWork,
        {
          service: backend.scaleSets,
          charged: (id) => runtime.pool.chargedInSet(id),
          creationReady: (label) => runtime.pool.creationReady(label),
          authority: backend.scaleSetAuthority.bind(backend),
          policy,
          report: (error) => this.options.host.report(error, 'scale-set-session'),
          wake: () => this.wake?.(),
        },
        signal,
      )
      try {
        await controller.restore()
      } catch (error) {
        await controller.close()
        throw error
      }
      runtime.sets = controller
    }
    if (!current && runtime.sets) {
      await runtime.sets.close()
      runtime.sets = undefined
    }
    if (current && runtime.sets) {
      // Authenticated job observations seed classes. Only Actions messages admit work.
      for (const row of records) {
        if (!row.key.startsWith('notice/') || !matches(scope, pendingJob(row))) continue
        const labels = object(row.payload) ? row.payload.labels : undefined
        if (Array.isArray(labels) && labels.every((label): label is string => typeof label === 'string')) {
          const selection = selectRunnerLabels(labels, this.worker.labels)
          if (selection) await runtime.sets.observe(selection.label)
        }
        await this.settle(session.lease, row)
      }
    }
    const targets = runtime.sets?.targets() ?? []
    const demand = targets.some((target) => target.assigned > 0)
    if (!recovering && !demand) return
    const activity = await this.journal.scope(session.lease, key)
    if (!activity.active && !demand) return
    session.planning.enqueue(
      key,
      JSON.stringify(targets.map((target) => target.check.version)) + activity.activity.version,
      async () => {
        let capacity = closedCapacity
        if (demand) {
          try {
            capacity = captureCapacity(await policy(signal))
          } catch (error) {
            signal.throwIfAborted()
            if (error instanceof LeaseLost) throw error
            this.options.host.report(error, 'scale-set-capacity')
          }
        }
        await runtime.pool.balanceScaleSets(session.lease, targets, capacity, signal, !current)
      },
    )
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
