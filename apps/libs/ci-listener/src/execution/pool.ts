/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { JobNotice, jobMatches, WorkflowJob } from '../jobs'
import { GitHubRunners, JitRegistration, RunnerEffect, RunnerObservation } from '../runners'
import { ExecutionLease, StateCheck } from '../state/store'
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
import { DemandUncertain, LabelDemand } from '../demand'
import { WorkQueue } from './work-queue'

export interface RunnerSession {
  registry: Pick<GitHubRunners, 'create' | 'lookup' | 'remove'> & Partial<Pick<GitHubRunners, 'list' | 'retireIdle'>>
  close(): Promise<void>
}
/** Hosts enforce authority again at actual Box/GitHub effects, including native onPersist. */
export interface PoolBackend {
  inventory?(signal?: AbortSignal): Promise<RunnerObservation[]>
  retire?(name: string): Promise<void>
  workers: WorkerExecutor
  admit(signal?: AbortSignal): Promise<void>
  job(notice: JobNotice, signal?: AbortSignal): Promise<WorkflowJob>
  runners(
    beforeMutation: (effect: RunnerEffect) => Promise<void>,
    signal?: AbortSignal,
    labels?: readonly string[],
    name?: string,
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
    | 'ci-worker-reserved'
    | 'ci-worker-execution-started'
    | 'ci-worker-execution-settled'
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
  queueWaitMs?: number
  durationMs?: number
}
const RUNNER_BOOTSTRAP_SECONDS = 300
const bootstrap = String.raw`set -eu
export DOCKER_HOST=unix:///var/run/docker.sock
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
docker_pid=
docker_log=/tmp/boxlite-ci-dockerd.log
docker_deadline=$((SECONDS + 120))

# Invoked indirectly by the EXIT trap.
# shellcheck disable=SC2329
cleanup_docker() {
  local bootstrap_status=$?
  if ((bootstrap_status != 0)) && [[ -f "$docker_log" ]]; then
    tail -n 60 "$docker_log" >&2 || true
  fi
  if [[ -n "$docker_pid" ]]; then
    kill "$docker_pid" >/dev/null 2>&1 || true
    wait "$docker_pid" 2>/dev/null || true
  fi
}
trap 'cleanup_docker' EXIT

docker_ready() {
  local remaining=$((docker_deadline - SECONDS))
  ((remaining > 0)) || return 1
  ((remaining <= 5)) || remaining=5
  timeout "$remaining" setpriv --reuid=runner --regid=docker --init-groups \
    env HOME=/home/runner USER=runner LOGNAME=runner docker info >/dev/null 2>&1
}

if ! docker_ready; then
  if ! command -v iptables >/dev/null 2>&1; then
    timeout "$((docker_deadline - SECONDS))" /bin/sh -ec '
      apt-get update -qq
      apt-get install -y --no-install-recommends iptables
    '
  fi
  dockerd --host="$DOCKER_HOST" --group=docker \
    --storage-driver=overlay2 --dns-search=. >"$docker_log" 2>&1 &
  docker_pid=$!
  until docker_ready; do
    if ((SECONDS >= docker_deadline)) || ! kill -0 "$docker_pid" 2>/dev/null; then
      printf 'CI Docker daemon failed to become ready within 120 seconds\n' >&2
      exit 1
    fi
    sleep 1
  done
fi

for ((attempt=0; attempt<${RUNNER_BOOTSTRAP_SECONDS}; attempt++)); do
  if [[ -f /home/runner/.boxlite-jitconfig.ready && -r /home/runner/.boxlite-jitconfig ]]; then
    ACTIONS_RUNNER_INPUT_JITCONFIG="$(cat /home/runner/.boxlite-jitconfig)"
    export ACTIONS_RUNNER_INPUT_JITCONFIG
    rm -f /home/runner/.boxlite-jitconfig /home/runner/.boxlite-jitconfig.ready
    exec setpriv --reuid=runner --regid=docker --init-groups \
      env HOME=/home/runner USER=runner LOGNAME=runner /home/runner/run.sh
  fi
  sleep 1
done
printf 'CI runner JIT configuration timed out\n' >&2
exit 1`

/** One scope supplies ephemeral runner capacity; a triggering job is not a runner assignment. */
export class WorkerPool {
  private busy = false
  private recovery = { lease: '', after: '', version: '', seen: 0, failed: false, ready: false }
  private readonly settings: PoolSettings
  private readonly jit = new Map<string, JitRegistration>()
  private readonly sessions = new Set<RunnerSession>()
  private demandAfter = 0
  private executionAfter = 0
  private readonly acceptedCreates = new Set<string>()
  private readonly idleRetryAt = new Map<string, number>()
  // Invalidate cached demand once for each newly unclaimed busy runner.
  private readonly busyRefreshes = new Set<number>()
  private readonly creationFailures = new Map<string, { attempts: number; retryAt: number }>()
  constructor(
    private readonly journal: ExecutionJournal,
    private readonly scopeKey: string,
    private readonly backend: (scope: ExecutionScope, lease: ExecutionLease) => Promise<PoolBackend>,
    settings: PoolSettings,
    private readonly observe: (event: WorkerEvent) => void = () => {},
    private readonly execution?: { queue: WorkQueue; wake(): void },
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
      if (!this.execution) await this.close()
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
            if (this.execution) this.dispatch(lease, row, backend, scope.scope, signal)
            else await this.reconcile(lease, row, backend, scope.scope, signal)
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
        const selection = selectRunnerLabels(current.labels, this.settings.labels)
        if (!selection || !this.creationReady(selection.label)) return
        const allocation = await this.journal.reserve(lease, this.scopeKey, demand, {
          ...policy,
          checks: [...(policy.checks ?? []), { key: scope.activity.key, version: this.recovery.version }],
        })
        if (allocation) {
          if (this.execution) {
            this.event(scope.scope, allocation, 'ci-worker-reserved', 'info')
            this.dispatch(lease, allocation, backend, scope.scope, signal)
          } else await this.reconcile(lease, allocation, backend, scope.scope, signal)
        }
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
  /** Count compatible supply once, reserve missing capacity, then advance independent resources. */
  async balance(
    lease: ExecutionLease,
    policy: CapacityPolicy,
    demands: readonly LabelDemand[],
    signal?: AbortSignal,
    verified: boolean | 'positive' = false,
    queueChecks: readonly StateCheck[] = [],
  ): Promise<void> {
    lease = { ...lease }
    policy = captureCapacity(policy)
    demands = demands.map((demand) => ({ ...demand, labels: [...demand.labels], job: { ...demand.job } }))
    if (this.busy) throw new Error('CI pool reconciliation is already running')
    this.busy = true
    try {
      signal?.throwIfAborted()
      // An accepted create may commit and leave the queue while journal pages are being read.
      // Count its pre-read grant if the page still shows an unissued reservation.
      for (const key of this.acceptedCreates) if (!this.execution?.queue.revision(key)) this.acceptedCreates.delete(key)
      const outstanding = new Set(this.acceptedCreates)
      const scope = await this.journal.scope(lease, this.scopeKey)
      if (!scope.active && demands.every((demand) => demand.queued === 0 && !demand.dirty)) return
      const backend = await this.backend(scope.scope, lease)
      const allocations: AllocationRow[] = []
      let after = ''
      do {
        const page = await this.journal.workers(lease, this.scopeKey, after)
        allocations.push(...page.rows)
        after = page.after
      } while (after)
      let inventory: Map<number, RunnerObservation>
      try {
        if (!backend.inventory) throw new Error('CI runner supply inventory is unavailable')
        inventory = new Map((await backend.inventory(signal)).map((runner) => [runner.id, runner]))
      } catch (error) {
        if (
          error instanceof LeaseLost ||
          error instanceof StateCorrupt ||
          error instanceof StateConflict ||
          signal?.aborted
        )
          throw error
        await this.reconcileAll(lease, allocations, backend, scope.scope, signal, new Set(), false)
        throw error
      }
      const supplied = new Map<string, number>()
      const unissued = new Map<string, number>()
      const unissuedLabels = new Map<string, string>()
      const idle = new Map<string, AllocationRow[]>()
      const retiring = new Set<string>()
      const active = new Set(allocations.map((row) => row.record.key))
      for (const key of this.idleRetryAt.keys()) if (!active.has(key)) this.idleRetryAt.delete(key)
      const claims = await this.journal.claimedRunners(
        lease,
        scope.scope,
        allocations.flatMap((row) =>
          row.value.runner.id !== null && inventory.get(row.value.runner.id)?.busy ? [row.value.runner.id] : [],
        ),
      )
      const unknownBusy = new Set<string>()
      const newBusy = new Map<number, string>()
      for (const id of this.busyRefreshes) if (!inventory.get(id)?.busy || claims.has(id)) this.busyRefreshes.delete(id)
      for (const [index, row] of allocations.entries()) {
        if (row.value.closing || row.value.box.phase === 'absent') continue
        // Legacy records have no label snapshot; only their recovery uses job details.
        let labels = row.value.supply?.labels
        if (!labels) {
          try {
            labels = (await backend.job(row.value.job, signal)).labels
          } catch (error) {
            if (
              error instanceof LeaseLost ||
              error instanceof StateCorrupt ||
              error instanceof StateConflict ||
              signal?.aborted
            )
              throw error
            await this.reconcileAll(lease, allocations, backend, scope.scope, signal, retiring, false)
            throw error
          }
        }
        const selection = selectRunnerLabels(labels, this.settings.labels)
        if (!selection) throw new StateCorrupt()
        const runner = row.value.runner.id === null ? undefined : inventory.get(row.value.runner.id)
        if (runner && runner.name !== row.value.name) throw new StateCorrupt()
        if (row.value.effect?.kind === 'runner-retire') {
          if (runner?.status === 'online' && !runner.busy) {
            supplied.set(selection.label, (supplied.get(selection.label) ?? 0) + 1)
            const candidates = idle.get(selection.label) ?? []
            candidates.push(row)
            idle.set(selection.label, candidates)
          }
          continue
        }
        if (row.value.runner.phase === 'known' && (!runner || (runner.status === 'offline' && !runner.busy))) {
          if (Date.now() - (row.value.runner.registeredAt ?? row.value.createdAt) >= RUNNER_BOOTSTRAP_SECONDS * 1000) {
            allocations[index] = await this.journal.advance(lease, row.record.key, row.record.version, {
              closing: true,
            })
          } else {
            // JIT delivery does not prove the runner has connected. Pending startup
            // consumes the same demand and quota until its bounded grace expires.
            supplied.set(selection.label, (supplied.get(selection.label) ?? 0) + 1)
          }
          continue
        }
        if (runner?.busy) {
          if (!claims.has(runner.id)) {
            unknownBusy.add(selection.label)
            if (!this.busyRefreshes.has(runner.id)) newBusy.set(runner.id, selection.label)
          }
          continue
        }
        if (runner && !selection.labels.every((label) => runner.labels.includes(label.toLowerCase())))
          throw new StateCorrupt()
        supplied.set(selection.label, (supplied.get(selection.label) ?? 0) + 1)
        if (row.value.box.phase === 'none') {
          unissued.set(selection.label, (unissued.get(selection.label) ?? 0) + 1)
          unissuedLabels.set(row.record.key, selection.label)
        }
        if (
          row.value.box.phase === 'none' ||
          (runner?.status === 'online' &&
            (row.value.delivery === 'done' || row.value.delivery === 'requested') &&
            Date.now() - (row.value.runner.registeredAt ?? row.value.createdAt) >= RUNNER_BOOTSTRAP_SECONDS * 1000 &&
            ((this.idleRetryAt.get(row.record.key) ?? 0) <= Date.now() || this.retirementQueued(row)))
        ) {
          const candidates = idle.get(selection.label) ?? []
          candidates.push(row)
          idle.set(selection.label, candidates)
        }
      }
      const totalDemand = new Map<string, number>()
      const requested = new Map<
        string,
        { count: number; demand: LabelDemand; labels: readonly string[]; checks: StateCheck[] }
      >()
      // Reserve one database check for the journal's scope fence. Omitted
      // counters contribute no demand; a later round starts at the first omission.
      const demandBudget = 99 - (policy.checks?.length ?? 0)
      let nextDemand: number | undefined
      for (let offset = 0; offset < demands.length; offset++) {
        const index = (this.demandAfter + offset) % demands.length,
          demand = demands[index]
        if (demand.dirty) throw new StateCorrupt()
        const selection = selectRunnerLabels(demand.labels, this.settings.labels)
        if (!selection || !demand.queued) continue
        totalDemand.set(selection.label, (totalDemand.get(selection.label) ?? 0) + demand.queued)
        const existing = requested.get(selection.label)
        const checks = new Map((existing?.checks ?? []).map((check) => [check.key, check]))
        if (demand.key && demand.version) {
          const prior = checks.get(demand.key)
          if (prior && prior.version !== demand.version) throw new StateConflict()
          checks.set(demand.key, {
            key: demand.key,
            version: demand.version,
            expiresAt: Math.min(prior?.expiresAt ?? Infinity, demand.expiresAt ?? Infinity),
          })
          if (checks.get(demand.key)!.expiresAt === Infinity) delete checks.get(demand.key)!.expiresAt
        }
        if (checks.size > demandBudget) {
          nextDemand ??= index
          continue
        }
        requested.set(selection.label, {
          count: (existing?.count ?? 0) + demand.queued,
          demand,
          labels: selection.labels,
          checks: [...checks.values()],
        })
      }
      this.demandAfter = nextDemand ?? 0
      const surplus: AllocationRow[] = []
      for (const [label, candidates] of idle) {
        let excess = Math.max(0, (supplied.get(label) ?? 0) - (totalDemand.get(label) ?? 0))
        candidates.sort((a, b) => Number(a.value.box.phase !== 'none') - Number(b.value.box.phase !== 'none'))
        if (verified === 'positive' && totalDemand.has(label) && this.execution) {
          // Only existing retirements can remove supply. Leave at most the verified surplus queued.
          const pending = candidates.filter((row) => this.retirementQueued(row))
          for (const row of pending.slice(excess))
            this.dispatch(lease, row, backend, scope.scope, signal, false, [], true)
        }
        for (const row of candidates) if (excess-- > 0) surplus.push(row)
      }
      const expanding =
        [...requested].some(([label, target]) => target.count > (supplied.get(label) ?? 0)) &&
        (await this.journal.hasCapacity(lease, this.scopeKey, policy))
      const missingClaims = [...requested].some(([label]) => unknownBusy.has(label))
      const needsRefresh = [...newBusy].filter(([, label]) => {
        const target = requested.get(label)?.count ?? 0
        const available = supplied.get(label) ?? 0
        const reserved = unissued.get(label) ?? 0
        // Starting an existing reservation needs fresh demand even when quota is full.
        return target > available - reserved && (reserved > 0 || expanding)
      })
      if (verified && needsRefresh.length) {
        for (const [id] of needsRefresh) this.busyRefreshes.add(id)
        await this.reconcileAll(lease, allocations, backend, scope.scope, signal, retiring, false)
        throw new DemandUncertain('New busy supply requires fresh job observations', true)
      }
      if (
        !verified &&
        (expanding ||
          surplus.length ||
          retiring.size ||
          allocations.some((row) => row.value.box.phase === 'none' && !row.value.closing))
      ) {
        await this.reconcileAll(lease, allocations, backend, scope.scope, signal, retiring, false)
        const refresh = needsRefresh.length > 0
        if (refresh) for (const [id] of needsRefresh) this.busyRefreshes.add(id)
        throw new DemandUncertain(
          missingClaims
            ? 'Runner claims arrived without matching demand observations'
            : 'Authoritative GitHub queue snapshot required before changing worker capacity',
          refresh,
        )
      }
      if (verified === true && (queueChecks.length > 0 || !this.execution) && queueChecks.length <= 100)
        for (const row of surplus) {
          if (
            row.value.box.phase === 'none' &&
            row.value.runner.phase === 'none' &&
            row.value.delivery === 'none' &&
            row.value.effect === null
          ) {
            allocations[allocations.indexOf(row)] = await this.journal.advance(
              lease,
              row.record.key,
              row.record.version,
              { closing: true, box: { phase: 'absent', id: null }, runner: { phase: 'absent', id: null } },
              queueChecks,
            )
          } else retiring.add(row.record.key)
        }
      const creationBudget = new Map<string, number>()
      for (const [label, target] of requested)
        creationBudget.set(label, Math.max(0, target.count - ((supplied.get(label) ?? 0) - (unissued.get(label) ?? 0))))
      const creationChecks = new Map<string, StateCheck[]>()
      if (verified) {
        // Reuse outstanding grants first, even when an earlier reservation's backoff just expired.
        const candidates = outstanding.size
          ? [
              ...allocations.filter((row) => outstanding.has(row.record.key)),
              ...allocations.filter((row) => !outstanding.has(row.record.key)),
            ]
          : allocations
        for (const row of candidates) {
          if (row.value.box.phase !== 'none' || row.value.closing || (this.execution && !row.value.supply)) continue
          const label = unissuedLabels.get(row.record.key)
          if (!label) continue
          const target = requested.get(label)
          const remaining = creationBudget.get(label) ?? 0
          if (!target || remaining <= 0) continue
          const checks = [...(policy.checks ?? []), ...target.checks]
          const accepted = !this.execution || this.dispatch(lease, row, backend, scope.scope, signal, false, checks)
          if (accepted) creationChecks.set(row.record.key, checks)
          if (accepted || outstanding.has(row.record.key)) creationBudget.set(label, remaining - 1)
        }
      }
      const proof = (row: AllocationRow, retire: boolean): readonly StateCheck[] | undefined => {
        if (retire)
          return queueChecks.length <= 100 && (queueChecks.length || !this.execution) ? queueChecks : undefined
        if (row.value.box.phase !== 'none' || row.value.closing) return []
        return creationChecks.get(row.record.key)
      }
      let pending = verified
      while (pending) {
        pending = false
        for (const [label, target] of requested) {
          const available = supplied.get(label) ?? 0
          if (available >= target.count || !this.creationReady(label)) continue
          signal?.throwIfAborted()
          await backend.admit(signal)
          const notice = {
            repository: target.demand.repositoryId,
            run: target.demand.job.runId,
            job: target.demand.job.id,
          }
          const row = await this.journal.reserve(
            lease,
            this.scopeKey,
            notice,
            { ...policy, checks: [...(policy.checks ?? []), ...target.checks] },
            { labels: [...target.labels] },
          )
          if (!row) {
            pending = false
            break
          }
          allocations.push(row)
          const checks = [...(policy.checks ?? []), ...target.checks]
          creationChecks.set(row.record.key, checks)
          if (this.execution) {
            this.event(scope.scope, row, 'ci-worker-reserved', 'info')
            this.dispatch(lease, row, backend, scope.scope, signal, false, checks)
          }
          supplied.set(label, available + 1)
          pending = true
        }
      }
      await this.reconcileAll(
        lease,
        allocations,
        backend,
        scope.scope,
        signal,
        retiring,
        true,
        proof,
        verified === true && queueChecks.length > 0 && queueChecks.length <= 100,
      )
    } finally {
      this.busy = false
    }
  }
  private creationReady(label: string): boolean {
    return (this.creationFailures.get(label)?.retryAt ?? 0) <= Date.now()
  }
  private creationRejected(label: string): void {
    const attempts = (this.creationFailures.get(label)?.attempts ?? 0) + 1
    this.creationFailures.delete(label)
    this.creationFailures.set(label, {
      attempts,
      retryAt: Date.now() + (attempts >= 3 ? 60000 : 1000 * 2 ** (attempts - 1)),
    })
    if (this.creationFailures.size > 4096) this.creationFailures.delete(this.creationFailures.keys().next().value!)
  }
  private async reconcileAll(
    lease: ExecutionLease,
    allocations: readonly AllocationRow[],
    backend: PoolBackend,
    scope: ExecutionScope,
    signal?: AbortSignal,
    retiring: ReadonlySet<string> = new Set(),
    allowCreate = true,
    proof?: (row: AllocationRow, retire: boolean) => readonly StateCheck[] | undefined,
    completePlan = false,
  ): Promise<void> {
    if (this.execution) {
      for (let offset = 0; offset < allocations.length; offset++) {
        const index = (this.executionAfter + offset) % allocations.length
        const row = allocations[index]
        if (!allowCreate && row.value.box.phase === 'none' && !row.value.closing) continue
        const retire = retiring.has(row.record.key)
        const checks = proof?.(row, retire)
        if (proof && checks === undefined) continue
        if (!this.dispatch(lease, row, backend, scope, signal, retire, checks, completePlan)) {
          this.executionAfter = (index + 1) % allocations.length
          break
        }
        if (offset === allocations.length - 1) this.executionAfter = (index + 1) % allocations.length
      }
      return
    }
    const results = await Promise.allSettled(
      allocations.map(async (row) => {
        if (!allowCreate && row.value.box.phase === 'none' && !row.value.closing) return
        const retire = retiring.has(row.record.key)
        const checks = proof?.(row, retire)
        if (proof && checks === undefined) return
        await backend.retire?.(row.value.name)
        try {
          await this.reconcile(lease, row, backend, scope, signal, retire, checks)
        } finally {
          await backend.retire?.(row.value.name)
        }
      }),
    )
    for (let index = 0; index < results.length; index++) {
      const result = results[index]
      if (result.status !== 'rejected') continue
      const error = result.reason
      if (error instanceof LeaseLost || error instanceof StateCorrupt || signal?.aborted) throw error
      const current = await this.journal.allocation(lease, allocations[index].record.key)
      if (current)
        this.event(scope, current, 'ci-worker-recovery-deferred', 'warn', {
          errorType: error instanceof Error ? error.constructor.name : 'Unknown',
        })
    }
  }
  private retirementQueued(row: AllocationRow): boolean {
    const revision = this.execution?.queue.revision(row.record.key)
    if (!revision) return false
    // Recording the running retirement's intent advances the allocation version.
    return (
      revision.startsWith(row.record.version + '/retire/') ||
      (row.value.effect?.kind === 'runner-retire' && /^[^/]+\/retire\//.test(revision))
    )
  }
  private dispatch(
    lease: ExecutionLease,
    planned: AllocationRow,
    backend: PoolBackend,
    scope: ExecutionScope,
    signal?: AbortSignal,
    retireIdle = false,
    checks: readonly StateCheck[] = [],
    replaceRetirement = false,
  ): boolean {
    const queue = this.execution!.queue
    const key = planned.record.key
    const retirement = planned.record.version + '/retire/'
    if (!replaceRetirement && !retireIdle && this.retirementQueued(planned)) return true
    const accepted = queue.enqueue(
      key,
      (retireIdle ? retirement : planned.record.version + '/recover/') + JSON.stringify(checks),
      async (queueWaitMs) => {
        signal?.throwIfAborted()
        const current = await this.journal.allocation(lease, planned.record.key)
        if (!current) return
        if (retireIdle && current.record.version !== planned.record.version) return
        const startedAt = Date.now()
        const timed = current.value.delivery !== 'done' || current.value.closing || retireIdle
        if (timed) this.event(scope, current, 'ci-worker-execution-started', 'info', { queueWaitMs })
        try {
          await backend.retire?.(current.value.name)
          const checkRetirement = retireIdle
            ? () => {
                if (!/^[^/]+\/retire\//.test(queue.revision(key) ?? '')) throw new StateConflict()
              }
            : undefined
          await this.reconcile(lease, current, backend, scope, signal, retireIdle, checks, checkRetirement)
        } finally {
          try {
            await backend.retire?.(current.value.name)
          } finally {
            const latest = await this.journal.allocation(lease, planned.record.key)
            if (latest?.record.version !== current.record.version) this.execution!.wake()
            if (timed)
              this.event(scope, latest ?? current, 'ci-worker-execution-settled', 'info', {
                durationMs: Date.now() - startedAt,
              })
          }
        }
      },
    )
    if (
      accepted &&
      backend.inventory &&
      planned.value.supply &&
      planned.value.box.phase === 'none' &&
      !planned.value.closing
    )
      this.acceptedCreates.add(key)
    return accepted
  }
  private async reconcile(
    lease: ExecutionLease,
    initial: AllocationRow,
    backend: PoolBackend,
    scope: ExecutionScope,
    signal?: AbortSignal,
    retireIdle = false,
    checks: readonly StateCheck[] = [],
    checkRetirement?: () => void,
  ): Promise<void> {
    let row = initial
    let selection: ReturnType<typeof selectRunnerLabels> | undefined
    const select = async () => {
      if (row.value.supply) {
        selection = selectRunnerLabels(row.value.supply.labels, this.settings.labels)
        if (!selection) throw new StateCorrupt()
        return selection
      }
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
    const intent = async (kind: EffectKind, change: AllocationChange = {}) => {
      row = await this.journal.advance(
        lease,
        row.record.key,
        row.record.version,
        { ...change, effect: { id: randomUUID(), kind } },
        kind === 'box-create' || kind === 'runner-retire' ? checks : [],
      )
    }
    const admit = async () => {
      try {
        await backend.admit(signal)
      } catch (error) {
        if (row.value.delivery === 'none') await update({ closing: true })
        throw error
      }
    }
    const registry = async <T>(
      work: (registry: RunnerSession['registry']) => Promise<T>,
      idleRetirement = false,
    ): Promise<T> => {
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
            if (idleRetirement) {
              checkRetirement?.()
              if (row.value.effect?.kind !== 'runner-retire') await intent('runner-retire')
              else {
                row = await this.journal.advance(
                  lease,
                  row.record.key,
                  row.record.version,
                  { effect: row.value.effect },
                  checks,
                )
              }
            } else await intent('runner-remove')
          }
        },
        signal,
        selection?.labels,
        row.value.name,
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
          this.creationFailures.delete(selected.label)
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
      this.creationRejected(
        selectRunnerLabels(row.value.supply?.labels ?? selection?.labels ?? this.settings.labels, this.settings.labels)!
          .label,
      )
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
        if (
          status === 'running' &&
          !row.value.closing &&
          row.value.runner.phase === 'known' &&
          row.value.delivery === 'requested' &&
          row.value.effect?.kind === 'jit-deliver' &&
          observed.recoverableJit &&
          backend.workers.recoverJit
        ) {
          const id = row.value.runner.id!
          const claimed = await this.journal.claimedRunners(lease, scope, [id])
          const runner = claimed.has(id)
            ? undefined
            : (await backend.inventory?.(signal))?.find((item) => item.id === id)
          if (runner && runner.name !== row.value.name) throw new StateCorrupt()
          if (claimed.has(id) || runner?.busy || runner?.status === 'online') await update({ delivery: 'done' })
          else {
            const result = await backend.workers.recoverJit(row.value.name, row.value.effect.id, signal)
            if (result === 'replace') await update({ closing: true })
            if (result === 'delivered') await update({ delivery: 'done' })
          }
        }
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
    if (!row.value.closing && retireIdle && row.value.runner.phase === 'known' && status === 'running') {
      if ((this.idleRetryAt.get(row.record.key) ?? 0) <= Date.now()) {
        this.idleRetryAt.set(row.record.key, Date.now() + 60000)
        const retired = await registry(
          (client) =>
            client.retireIdle?.({ id: row.value.runner.id!, name: row.value.name }, signal, checkRetirement) ??
            Promise.resolve(false),
          true,
        )
        if (retired) {
          if (row.value.effect?.kind !== 'runner-retire') throw new StateCorrupt()
          await update({ runner: { phase: 'absent', id: row.value.runner.id }, closing: true })
          this.idleRetryAt.delete(row.record.key)
        }
      }
    }
    if (!row.value.closing && status === 'running' && row.value.runner.phase === 'none') {
      if (selection === undefined) await select()
      if (selection) {
        const registration = await registry((client) => client.create(row.value.name, signal))
        this.jit.set(row.record.key, registration)
        await update({ runner: { phase: 'known', id: registration.id, registeredAt: Date.now() } })
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
    details: Pick<WorkerEvent, 'status' | 'exitCode' | 'errorType' | 'queueWaitMs' | 'durationMs'> = {},
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
