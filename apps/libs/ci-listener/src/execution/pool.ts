/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { JobNotice } from '../jobs'
import { JitRegistration, RunnerEffect, RunnerIdentity } from '../runners'
import { ExecutionLease, StateCheck } from '../state/store'
import { LeaseLost, StateConflict, StateCorrupt } from '../state/database'
import {
  ConfirmedWorkerAbsent,
  ConfirmedWorkerCreationRejected,
  DEFAULT_WORKER_DISK_GIB,
  validateWorkerResources,
  WorkerExecutor,
  WorkerLaunch,
} from '../worker'
import { DEFAULT_RESOURCE_LABEL, parseResourceLabels, selectRunnerLabels } from '../resource-labels'
import { AllocationChange, AllocationRow, ExecutionJournal } from './journal'
import { EffectKind, ExecutionScope } from './model'
import { CapacityPolicy } from '../capacity'
import { WorkQueue } from './work-queue'

export interface RunnerSession {
  registry: {
    create(name: string, signal?: AbortSignal): Promise<JitRegistration>
    lookup(identity: { id?: number; name: string }, signal?: AbortSignal): Promise<RunnerIdentity | null>
    remove(identity: RunnerIdentity, signal?: AbortSignal): Promise<void>
    retireIdle?(identity: RunnerIdentity, signal?: AbortSignal, checkRetirement?: () => void): Promise<boolean>
  }
  close(): Promise<void>
}
/** Hosts enforce authority again at actual Box/GitHub effects, including native onPersist. */
export interface PoolBackend {
  retire?(name: string): Promise<void>
  workers: WorkerExecutor
  admit(signal?: AbortSignal): Promise<void>
  runners(
    beforeMutation: (effect: RunnerEffect) => Promise<void>,
    signal?: AbortSignal,
    labels?: readonly string[],
    name?: string,
    scaleSet?: number,
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
  trigger: JobNotice | null
  scaleSet?: number
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
  private readonly settings: PoolSettings
  private readonly setCharges = new Map<number, number>()
  private readonly jit = new Map<string, JitRegistration>()
  private readonly sessions = new Set<RunnerSession>()
  private executionAfter = 0
  private readonly idleRetryAt = new Map<string, number>()
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
  async close(): Promise<void> {
    this.jit.clear()
    for (const session of this.sessions) {
      await session.close()
      this.sessions.delete(session)
    }
  }
  chargedInSet(id: number): number {
    return this.setCharges.get(id) ?? 0
  }
  /** Reconcile the assigned count including charged reservations which have not reached GitHub yet. */
  async balanceScaleSets(
    lease: ExecutionLease,
    targets: readonly { id: number; labels: string[]; assigned: number; held: number; check: StateCheck }[],
    policy: CapacityPolicy,
    signal: AbortSignal,
    drain?: StateCheck,
  ): Promise<void> {
    const scope = await this.journal.scope(lease, this.scopeKey)
    const backend = await this.backend(scope.scope, lease)
    const rows: AllocationRow[] = []
    let after = ''
    while (scope.active) {
      const page = await this.journal.workers(lease, this.scopeKey, after)
      rows.push(...page.rows)
      if (!page.after) break
      after = page.after
    }
    // A membership change invalidates the count used to admit the next worker.
    let activity = scope.activity
    const snapshot = await this.journal.scope(lease, this.scopeKey)
    if (activity.version !== snapshot.activity.version || rows.length !== snapshot.active) throw new StateConflict()
    for (const row of rows) {
      if (row.value.supply?.scaleSet && drain && row.value.box.phase === 'none' && !row.value.closing) {
        Object.assign(
          row,
          await this.journal.advance(lease, row.record.key, row.record.version, { closing: true }, [drain]),
        )
      }
    }
    this.setCharges.clear()
    for (const row of rows) {
      const set = row.value.supply?.scaleSet
      if (set && row.value.box.phase !== 'absent') this.setCharges.set(set, this.chargedInSet(set) + 1)
    }
    const checks = new Map<number, StateCheck[]>()
    let admissionFailure: { cause: unknown } | undefined
    const waitingForAssignment = new Set<string>()
    const retire = new Set<string>()
    for (const row of rows)
      if (drain && row.value.supply?.scaleSet && row.value.delivery === 'done' && !row.value.closing)
        retire.add(row.record.key)
    for (const target of targets) {
      signal.throwIfAborted()
      const selection = selectRunnerLabels(target.labels, this.settings.labels)
      if (!selection) throw new StateCorrupt()
      const original = rows.filter(
        (row) => row.value.supply?.scaleSet === target.id && !row.value.closing && row.value.box.phase !== 'absent',
      )
      // Keep an acquired slot charged while its service assignment is pending.
      // Count dispatched workers first so a queued reservation cannot start a surplus Box.
      const undispatched = original.filter((row) => row.value.box.phase === 'none')
      const ready = this.creationReady(selection.label)
      const grants = ready ? Math.max(0, target.assigned - (original.length - undispatched.length)) : 0
      for (const row of undispatched.slice(grants)) waitingForAssignment.add(row.record.key)
      const proof = [...(policy.checks ?? []), target.check]
      checks.set(target.id, proof)
      // Withdraw undispatched reservations first. An in-flight Box keeps its immutable identity.
      const surplus = Math.max(0, original.length - target.assigned - target.held)
      const dispatched = original.filter((row) => row.value.box.phase !== 'none')
      for (const row of [...dispatched, ...undispatched].reverse().slice(0, surplus)) {
        if (row.value.box.phase === 'none') {
          const changed = await this.journal.advance(
            lease,
            row.record.key,
            row.record.version,
            { closing: true },
            proof,
          )
          Object.assign(row, changed)
        } else if (row.value.delivery === 'done') retire.add(row.record.key)
      }
      if (!ready || admissionFailure) continue
      for (let count = original.length; count < Math.min(target.assigned, original.length + 16); count++) {
        try {
          await backend.admit(signal)
        } catch (error) {
          if (
            error instanceof LeaseLost ||
            error instanceof StateCorrupt ||
            error instanceof StateConflict ||
            signal.aborted
          )
            throw error
          admissionFailure = { cause: error }
          break
        }
        const row = await this.journal.reserve(
          lease,
          this.scopeKey,
          null,
          {
            ...policy,
            checks: [...proof, { key: activity.key, version: activity.version }],
          },
          { labels: target.labels, scaleSet: target.id },
        )
        if (!row) break
        const next = await this.journal.scope(lease, this.scopeKey)
        // A concurrent release may have changed the count; a new pass takes a complete snapshot.
        if (next.active !== rows.length + 1) throw new StateConflict()
        activity = next.activity
        rows.push(row)
        this.setCharges.set(target.id, this.chargedInSet(target.id) + 1)
        this.event(scope.scope, row, 'ci-worker-reserved', 'info')
      }
    }
    await this.reconcileAll(
      lease,
      rows.filter((row) => row.value.supply?.scaleSet),
      backend,
      scope.scope,
      signal,
      retire,
      true,
      (row, retiring) => {
        const set = row.value.supply?.scaleSet
        if (waitingForAssignment.has(row.record.key) && !row.value.closing) return undefined
        if ((row.value.box.phase === 'none' && !row.value.closing) || retiring)
          return retiring && drain ? [drain] : set ? checks.get(set) : undefined
        return []
      },
      true,
    )
    if (admissionFailure) throw admissionFailure.cause
  }
  creationReady(label: string): boolean {
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
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
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
    const revision = (retireIdle ? retirement : planned.record.version + '/recover/') + JSON.stringify(checks)
    const accepted = queue.enqueue(key, revision, async (queueWaitMs) => {
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
              if (!queue.isCurrent(key, revision)) throw new StateConflict()
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
    })
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
    const select = () => {
      if (!row.value.supply?.scaleSet) throw new StateCorrupt()
      selection = selectRunnerLabels(row.value.supply.labels, this.settings.labels)
      if (!selection) throw new StateCorrupt()
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
        ...(row.value.supply?.scaleSet ? [row.value.supply.scaleSet] : []),
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
        const selected = select()
        if (selected) {
          if (row.value.supply?.scaleSet && !this.creationReady(selected.label)) return
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
          if (!row.value.supply?.scaleSet) this.creationFailures.delete(selected.label)
        }
      }
      if (row.value.box.phase === 'requested') {
        let originalId: string
        try {
          originalId = (await backend.workers.get(row.value.name)).box_id
        } catch (error) {
          const proof = error instanceof ConfirmedWorkerAbsent && error.creation
          if (!proof || row.value.effect?.kind !== 'box-create' || proof.effect !== row.value.effect.id) throw error
          originalId = proof.boxId
        }
        // Persist the recovered identity before the normal known-Box check can release quota.
        await update({ box: { phase: 'known', id: originalId } })
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
          if (row.value.runner.worked) await update({ delivery: 'done' })
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
      if (row.value.supply?.scaleSet) {
        const label = selectRunnerLabels(row.value.supply.labels, this.settings.labels)!.label
        if (row.value.runner.worked) this.creationFailures.delete(label)
        else this.creationRejected(label)
      }
      this.event(scope, row, 'ci-worker-exited', status === 'stopped' && exitCode === 0 ? 'info' : 'warn', {
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
      })
    }
    if (
      !row.value.closing &&
      !retireIdle &&
      row.value.effect?.kind === 'runner-retire' &&
      row.value.runner.phase === 'known' &&
      status === 'running' &&
      (this.idleRetryAt.get(row.record.key) ?? 0) <= Date.now()
    ) {
      this.idleRetryAt.set(row.record.key, Date.now() + 60000)
      const identity = { name: row.value.name, id: row.value.runner.id! }
      const original = await registry((client) => client.lookup(identity, signal))
      if (!original) await update({ closing: true, runner: { phase: 'absent', id: identity.id } })
    }
    if (!row.value.closing && retireIdle && row.value.runner.phase === 'known' && status === 'running') {
      if ((this.idleRetryAt.get(row.record.key) ?? 0) <= Date.now()) {
        this.idleRetryAt.set(row.record.key, Date.now() + 60000)
        const previousEffect = row.value.effect
        let withdrawn = false
        const beforeDelete = () => {
          try {
            checkRetirement?.()
          } catch (error) {
            withdrawn = true
            throw error
          }
        }
        let retired: boolean
        try {
          retired = await registry(
            (client) =>
              client.retireIdle?.({ id: row.value.runner.id!, name: row.value.name }, signal, beforeDelete) ??
              Promise.resolve(false),
            true,
          )
        } catch (error) {
          if (withdrawn && previousEffect?.kind !== 'runner-retire' && row.value.effect?.kind === 'runner-retire')
            await update({ effect: previousEffect })
          throw error
        }
        if (retired) {
          if (row.value.effect?.kind !== 'runner-retire') throw new StateCorrupt()
          await update({ runner: { phase: 'absent', id: row.value.runner.id }, closing: true })
          this.idleRetryAt.delete(row.record.key)
        }
      }
    }
    if (!row.value.closing && status === 'running' && row.value.runner.phase === 'none') {
      if (selection === undefined) select()
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
      this.idleRetryAt.delete(row.record.key)
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
      trigger: value.job && { ...value.job },
      ...(value.supply?.scaleSet ? { scaleSet: value.supply.scaleSet } : {}),
      boxPhase: value.box.phase,
      runnerPhase: value.runner.phase,
      effect: value.effect?.kind ?? null,
      ...details,
    })
  }
}
