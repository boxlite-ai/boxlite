/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { JobNotice, jobMatches, WorkflowJob } from '../jobs'
import { GitHubRunners, JitRegistration, RunnerEffect } from '../runners'
import { ExecutionLease } from '../state/store'
import { LeaseLost, StateConflict, StateCorrupt } from '../state/database'
import {
  ConfirmedWorkerCreationRejected,
  DEFAULT_WORKER_DISK_GIB,
  validateWorkerResources,
  WorkerExecutor,
  WorkerLaunch,
} from '../worker'
import { DEFAULT_RESOURCE_LABEL, parseResourceLabels, selectRunnerLabels } from '../resource-labels'
import { AllocationChange, AllocationRow, ExecutionJournal } from './journal'
import { EffectKind, ExecutionScope } from './model'
import { CapacityPolicy, captureCapacity } from '../capacity'

export interface RunnerSession {
  registry: Pick<GitHubRunners, 'create' | 'lookup' | 'remove'>
  close(): Promise<void>
}
/** Hosts enforce authority again at actual Box/GitHub effects, including native onPersist. */
export interface PoolBackend {
  workers: WorkerExecutor
  admit(signal?: AbortSignal): Promise<void>
  job(notice: JobNotice, signal?: AbortSignal): Promise<WorkflowJob>
  runners(
    beforeMutation: (effect: RunnerEffect) => Promise<void>,
    signal?: AbortSignal,
    labels?: readonly string[],
  ): Promise<RunnerSession>
}
export interface PoolSettings {
  image: string
  cpus: number
  memoryMiB: number
  labels: readonly string[]
}
/** Observed worker facts, not a verdict on the triggering GitHub job. */
export interface WorkerEvent {
  event:
    | 'ci-worker-exited'
    | 'ci-worker-box-absent'
    | 'ci-worker-recovery-deferred'
    | 'ci-worker-released'
    | 'ci-worker-create-rejected'
  level: 'info' | 'warn'
  scope: string
  binding: string
  generation: number
  organization: string
  installation: number
  account: number
  allocation: string
  name: string
  boxId: string | null
  runnerId: number | null
  trigger: JobNotice
  boxPhase: string
  runnerPhase: string
  effect: EffectKind | null
  status?: string
  exitCode?: number | null
  errorType?: string
}
const bootstrap = `set -eu
for ((attempt=0; attempt<300; attempt++)); do
  if [[ -f /home/runner/.boxlite-jitconfig.ready && -r /home/runner/.boxlite-jitconfig ]]; then
    ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat /home/runner/.boxlite-jitconfig)"
    export ACTIONS_RUNNER_INPUT_JITCONFIG
    rm -f /home/runner/.boxlite-jitconfig /home/runner/.boxlite-jitconfig.ready
    exec /home/runner/run.sh
  fi
  sleep 1
done
exit 1`

/** One scope supplies ephemeral runner capacity; a triggering job is not a runner assignment. */
export class WorkerPool {
  private busy = false
  private recovery = { lease: '', after: '', version: '', seen: 0, failed: false, ready: false }
  private readonly settings: PoolSettings
  private readonly jit = new Map<string, JitRegistration>()
  private readonly sessions = new Set<RunnerSession>()
  constructor(
    private readonly journal: ExecutionJournal,
    private readonly scopeKey: string,
    private readonly backend: (scope: ExecutionScope, lease: ExecutionLease) => Promise<PoolBackend>,
    settings: PoolSettings,
    private readonly observe: (event: WorkerEvent) => void = () => {},
  ) {
    validateWorkerResources(settings)
    if (
      !settings.image ||
      !settings.labels.length ||
      settings.labels.length > 100 ||
      settings.labels.some((label) => !label || label.length > 128) ||
      parseResourceLabels(settings.labels)?.label !== DEFAULT_RESOURCE_LABEL
    )
      throw new Error('Invalid CI worker settings')
    this.settings = { ...settings, labels: [...settings.labels] }
  }
  async tick(lease: ExecutionLease, policy: CapacityPolicy, demand?: JobNotice, signal?: AbortSignal): Promise<void> {
    lease = { ...lease }
    policy = captureCapacity(policy)
    demand = demand ? { ...demand } : undefined
    if (this.busy) throw new Error('CI pool reconciliation is already running')
    this.busy = true
    try {
      signal?.throwIfAborted()
      const identity = JSON.stringify(lease)
      if (this.recovery.lease !== identity)
        this.recovery = { lease: identity, after: '', version: '', seen: 0, failed: false, ready: false }
      const scope = await this.journal.scope(lease, this.scopeKey)
      if (this.recovery.version !== scope.activity.version) this.recovery.ready = false
      if (!scope.active && !demand) {
        this.recovery = {
          lease: identity,
          after: '',
          version: scope.activity.version,
          seen: 0,
          failed: false,
          ready: true,
        }
        return
      }
      await this.close()
      const backend = await this.backend(scope.scope, lease)
      const failures: unknown[] = []
      // Only a completed clean round grants a single admission attempt. Starting
      // another round expires that permit; page rotation alone cannot clear debt.
      if (!demand || !this.recovery.ready) {
        this.recovery.ready = false
        if (!this.recovery.after) {
          this.recovery.failed = false
          this.recovery.seen = 0
          this.recovery.version = scope.activity.version
        }
        if (scope.activity.version !== this.recovery.version) this.recovery.failed = true
        const page = await this.journal.workers(lease, this.scopeKey, this.recovery.after)
        for (const row of page.rows) {
          const key = row.record.key
          try {
            await this.reconcile(lease, row, backend, scope.scope, signal)
          } catch (error) {
            if (
              error instanceof LeaseLost ||
              error instanceof StateCorrupt ||
              error instanceof StateConflict ||
              signal?.aborted ||
              this.sessions.size
            )
              throw error
            const current = await this.journal.allocation(lease, key)
            if (!current) throw error
            this.event(scope.scope, current, 'ci-worker-recovery-deferred', 'warn', {
              errorType: error instanceof Error ? error.constructor.name : 'Unknown',
            })
            // Only a confirmed-absent Box's registration debt may coexist with
            // fresh admission. Other failures retain capacity and block this scope.
            if (current.value.box.phase !== 'absent') {
              this.recovery.failed = true
              failures.push(error)
            }
          }
        }
        this.recovery.seen += page.rows.length
        this.recovery.after = page.after
        // Membership can change while a page awaits external effects, including
        // our own final releases. A new clean round must cover that membership.
        const current = await this.journal.scope(lease, this.scopeKey)
        if (current.activity.version !== this.recovery.version) this.recovery.failed = true
        if (!page.after && current.activity.version === this.recovery.version && this.recovery.seen !== current.active)
          throw new StateCorrupt()
        this.recovery.ready = !page.after && !this.recovery.failed
      }
      if (failures.length) throw failures[0]
      if (demand && this.recovery.ready) {
        this.recovery.ready = false
        await backend.admit(signal)
        const current = await backend.job(demand, signal)
        if (current.repository !== demand.repository || current.run !== demand.run || current.job !== demand.job)
          throw new Error('Original job identity changed at admission')
        if (!jobMatches(current, this.settings.labels)) return
        const allocation = await this.journal.reserve(lease, this.scopeKey, demand, {
          ...policy,
          checks: [...(policy.checks ?? []), { key: scope.activity.key, version: this.recovery.version }],
        })
        if (allocation) await this.reconcile(lease, allocation, backend, scope.scope, signal)
      }
    } finally {
      this.busy = false
    }
  }
  async close(): Promise<void> {
    this.jit.clear()
    for (const session of this.sessions) {
      await session.close()
      this.sessions.delete(session)
    }
  }
  private async reconcile(
    lease: ExecutionLease,
    initial: AllocationRow,
    backend: PoolBackend,
    scope: ExecutionScope,
    signal?: AbortSignal,
  ): Promise<void> {
    let row = initial
    let selection: ReturnType<typeof selectRunnerLabels> | undefined
    const select = async () => {
      const original = row.value.job
      const current = await backend.job(original, signal)
      if (current.repository !== original.repository || current.run !== original.run || current.job !== original.job)
        throw new Error('Original job identity changed at creation')
      selection = jobMatches(current, this.settings.labels)
        ? selectRunnerLabels(current.labels, this.settings.labels)
        : null
      if (!selection) await update({ closing: true })
      return selection
    }
    const update = async (change: AllocationChange) => {
      row = await this.journal.advance(lease, row.record.key, row.record.version, change)
    }
    const intent = async (kind: EffectKind, change: AllocationChange = {}) =>
      update({ ...change, effect: { id: randomUUID(), kind } })
    const admit = async () => {
      try {
        await backend.admit(signal)
      } catch (error) {
        if (row.value.delivery === 'none') await update({ closing: true })
        throw error
      }
    }
    const registry = async <T>(work: (registry: RunnerSession['registry']) => Promise<T>): Promise<T> => {
      const session = await backend.runners(
        async (effect) => {
          if (effect.name !== row.value.name) throw new Error('Original CI runner name changed')
          if (effect.kind === 'register') {
            if (row.value.runner.phase !== 'none' || row.value.closing)
              throw new Error('CI runner registration was already attempted')
            await admit()
            await intent('runner-register', { runner: { phase: 'requested', id: null } })
          } else {
            if (row.value.runner.phase !== 'known' || row.value.runner.id !== effect.id)
              throw new Error('Known original CI runner required for removal')
            await intent('runner-remove')
          }
        },
        signal,
        selection?.labels,
      )
      this.sessions.add(session)
      try {
        return await work(session.registry)
      } finally {
        await session.close()
        this.sessions.delete(session)
      }
    }
    signal?.throwIfAborted()
    try {
      if (row.value.box.phase === 'none' && !row.value.closing) {
        await admit()
        const selected = await select()
        if (selected) {
          await intent('box-create', { box: { phase: 'requested', id: null } })
          const launch: WorkerLaunch = {
            name: row.value.name,
            image: this.settings.image,
            cpus: this.settings.cpus,
            memoryMiB: this.settings.memoryMiB,
            diskGiB: DEFAULT_WORKER_DISK_GIB,
            ...selected.resources,
            entrypoint: ['/bin/bash', '-c', bootstrap],
          }
          const created = await backend.workers.create(launch)
          await update({ box: { phase: 'known', id: created.box_id } })
        }
      }
      if (row.value.box.phase === 'requested') {
        // A positive host ledger lookup may recover an original ID. No absence
        // response can settle an unknown create, and the POST is never repeated.
        const observed = await backend.workers.get(row.value.name)
        await update({ box: { phase: 'known', id: observed.box_id } })
      }
    } catch (error) {
      if (!(error instanceof ConfirmedWorkerCreationRejected)) throw error
      await this.journal.rejectCreation(lease, row.record.key, row.record.version, error.rejectedCreationEffect)
      this.event(scope, row, 'ci-worker-create-rejected', 'warn')
      return
    }
    let status: string | undefined, exitCode: number | null | undefined
    if (row.value.box.phase === 'known') {
      try {
        const observed = await backend.workers.get(row.value.name)
        if (observed.box_id !== row.value.box.id) throw new Error('Original CI Box identity changed')
        status = observed.status
        exitCode = observed.exit_code
      } catch (error) {
        if (error instanceof Error && (error as Error & { confirmedBoxAbsent?: boolean }).confirmedBoxAbsent === true) {
          const unexpected = !row.value.closing
          await update({ box: { phase: 'absent', id: row.value.box.id }, closing: true })
          this.event(scope, row, 'ci-worker-box-absent', unexpected ? 'warn' : 'info')
        } else throw error
      }
    }
    if (row.value.runner.phase === 'requested') {
      const found = await registry((client) => client.lookup({ name: row.value.name }, signal))
      if (found) {
        await update({ runner: { phase: 'known', id: found.id }, closing: true })
      } else {
        await update({ closing: true })
      }
    }
    if ((status === 'stopped' || status === 'error') && !row.value.closing) {
      await update({ closing: true })
      this.event(scope, row, 'ci-worker-exited', status === 'stopped' && exitCode === 0 ? 'info' : 'warn', {
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
      })
    }
    if (!row.value.closing && status === 'running' && row.value.runner.phase === 'none') {
      if (selection === undefined) await select()
      if (selection) {
        const registration = await registry((client) => client.create(row.value.name, signal))
        this.jit.set(row.record.key, registration)
        await update({ runner: { phase: 'known', id: registration.id } })
      }
    }
    if (!row.value.closing && row.value.runner.phase === 'known' && row.value.delivery === 'none') {
      const registration = this.jit.get(row.record.key)
      if (!registration?.usable) await update({ closing: true })
      else {
        await admit()
        await intent('jit-deliver', { delivery: 'requested' })
        try {
          await registration.deliver(backend.workers, signal)
          await update({ delivery: 'done' })
        } finally {
          this.jit.delete(row.record.key)
        }
      }
    }
    if (!row.value.closing) return
    this.jit.delete(row.record.key)
    if (row.value.box.phase === 'none') await update({ box: { phase: 'absent', id: null } })
    if (row.value.box.phase === 'known') {
      if (status === 'running' || status === 'starting' || status === 'created') {
        await intent('box-stop')
        await backend.workers.stop(row.value.name)
        return
      }
      if (status === 'stopped' || status === 'error') {
        await intent('box-remove')
        await backend.workers.remove(row.value.name)
        return
      }
      return
    }
    if (row.value.box.phase !== 'absent') return
    if (row.value.runner.phase === 'none') await update({ runner: { phase: 'absent', id: null } })
    if (row.value.runner.phase === 'known') {
      await registry((client) => client.remove({ id: row.value.runner.id!, name: row.value.name }, signal))
      await update({ runner: { phase: 'absent', id: row.value.runner.id } })
    }
    if (row.value.runner.phase === 'absent') {
      await this.journal.release(lease, row.record.key, row.record.version)
      this.event(scope, row, 'ci-worker-released', 'info')
    }
  }
  private event(
    scope: ExecutionScope,
    row: AllocationRow,
    event: WorkerEvent['event'],
    level: WorkerEvent['level'],
    details: Pick<WorkerEvent, 'status' | 'exitCode' | 'errorType'> = {},
  ): void {
    const value = row.value
    this.observe({
      event,
      level,
      scope: value.scope,
      binding: scope.binding,
      generation: scope.generation,
      organization: scope.organization,
      installation: scope.installation.id,
      account: scope.installation.account.id,
      allocation: row.record.key,
      name: value.name,
      boxId: value.box.id,
      runnerId: value.runner.id,
      trigger: { ...value.job },
      boxPhase: value.box.phase,
      runnerPhase: value.runner.phase,
      effect: value.effect?.kind ?? null,
      ...details,
    })
  }
}
