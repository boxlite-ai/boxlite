/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { randomUUID } from 'node:crypto'
import { JobNotice } from '../jobs'
import { Json, StateConflict, StateCorrupt, StateRecord } from '../state/database'
import { ExecutionLease, ListenerState } from '../state/store'
import { Allocation, decodeAllocation, decodeScope, ExecutionScope, object, positive, scopeKey } from './model'
import { CapacityPolicy, captureCapacity, hasCapacity } from '../capacity'

interface ScopeRow {
  record: StateRecord
  scope: ExecutionScope
  active: string[]
}
export interface AllocationRow {
  record: StateRecord
  value: Allocation
}
interface Snapshot {
  index: StateRecord
  scopes: Map<string, ScopeRow>
  allocations: Map<string, AllocationRow>
  workers: ExecutionScope[]
}
export type AllocationChange = Partial<Pick<Allocation, 'box' | 'runner' | 'delivery' | 'closing' | 'effect'>>
const json = (value: unknown) => value as Json

/** Permanent scope references and the allocation intent form one recoverable graph. */
export class ExecutionJournal {
  constructor(private readonly state: ListenerState) {}
  initialize(initial: { key: string; payload: Json }[] = []): Promise<void> {
    return this.state.initialize([{ key: 'catalog/scopes', payload: { keys: [] } }, ...initial])
  }
  async load(lease: ExecutionLease): Promise<Snapshot> {
    lease = { ...lease }
    const rows = await this.state.recover(lease, 100_000, ['catalog/', 'scope/', 'worker/']),
      records = new Map(rows.map((row) => [row.key, row]))
    const index = records.get('catalog/scopes')
    if (
      !index ||
      !object(index.payload) ||
      !Array.isArray(index.payload.keys) ||
      index.payload.keys.length > 10000 ||
      !index.payload.keys.every((key) => typeof key === 'string' && /^scope\/[a-f0-9]{64}$/.test(key)) ||
      new Set(index.payload.keys).size !== index.payload.keys.length
    )
      throw new StateCorrupt()
    const scopes = new Map<string, ScopeRow>(),
      allocations = new Map<string, AllocationRow>(),
      referenced = new Set<string>()
    for (const key of index.payload.keys) {
      const row = records.get(key as string)
      if (
        !row ||
        !object(row.payload) ||
        !Array.isArray(row.payload.active) ||
        row.payload.active.length > 10000 ||
        !row.payload.active.every((item) => typeof item === 'string' && /^worker\/[a-f0-9]{32}$/.test(item)) ||
        new Set(row.payload.active).size !== row.payload.active.length
      )
        throw new StateCorrupt()
      const scope = decodeScope(row.payload.scope)
      if (scopeKey(scope) !== key) throw new StateCorrupt()
      const active = row.payload.active as string[]
      scopes.set(key as string, { record: row, scope, active })
      for (const worker of active) {
        const record = records.get(worker)
        if (!record || referenced.has(worker)) throw new StateCorrupt()
        const value = decodeAllocation(record.payload)
        if (value.scope !== key || worker !== 'worker/' + value.name.slice('ci-jit-'.length)) throw new StateCorrupt()
        referenced.add(worker)
        allocations.set(worker, { record, value })
      }
    }
    for (const row of rows)
      if (
        row.key !== 'catalog/scopes' &&
        (row.key.startsWith('scope/')
          ? !scopes.has(row.key)
          : row.key.startsWith('worker/')
            ? !referenced.has(row.key)
            : true)
      )
        throw new StateCorrupt()
    // Runner cleanup debt remains indexed, but confirmed Box absence returns capacity.
    const workers = [...allocations.values()]
      .filter((row) => row.value.box.phase !== 'absent')
      .map((row) => scopes.get(row.value.scope)!.scope)
    return { index, scopes, allocations, workers }
  }
  async define(lease: ExecutionLease, definition: ExecutionScope, application?: string): Promise<string> {
    lease = { ...lease }
    const scope = decodeScope(definition),
      key = scopeKey(scope),
      snapshot = await this.load(lease)
    const appKey = 'app-scope/' + key.slice(6)
    if (application !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(application)) throw new StateCorrupt()
    if (snapshot.scopes.has(key)) {
      if (application !== undefined) {
        const [owned] = await this.state.read([appKey])
        if (!owned || !object(owned.payload) || owned.payload.application !== application) throw new StateCorrupt()
      }
      return key
    }
    if (snapshot.scopes.size >= 10000) throw new Error('Listener scope history limit reached')
    await this.state.commit(lease, [
      {
        key: 'catalog/scopes',
        expected: snapshot.index.version,
        payload: { keys: [...snapshot.scopes.keys(), key].sort() },
      },
      { key, expected: null, payload: json({ scope, active: [] }) },
      ...(application === undefined ? [] : [{ key: appKey, expected: null, payload: { application } }]),
    ])
    return key
  }
  async reserve(
    lease: ExecutionLease,
    scope: string,
    notice: JobNotice,
    policy: CapacityPolicy,
  ): Promise<AllocationRow | undefined> {
    lease = { ...lease }
    notice = { ...notice }
    policy = captureCapacity(policy)
    if (!positive(notice.repository) || !positive(notice.run) || !positive(notice.job))
      throw new Error('Invalid CI admission request')
    const snapshot = await this.load(lease),
      target = snapshot.scopes.get(scope)
    if (!target) throw new StateCorrupt()
    const runner = target.scope.runners
    if (
      runner.kind === 'repository'
        ? runner.repository.id !== notice.repository
        : !runner.repositories.includes(notice.repository)
    )
      throw new Error('CI job is outside its execution scope')
    for (const entry of snapshot.allocations.values()) {
      const previous = snapshot.scopes.get(entry.value.scope)!.scope
      if (
        previous.installation.id === target.scope.installation.id &&
        entry.value.job.repository === notice.repository &&
        entry.value.job.job === notice.job
      )
        return undefined
    }
    if (!hasCapacity(target.scope, snapshot.workers, policy)) return undefined
    const id = randomUUID().replaceAll('-', ''),
      key = 'worker/' + id
    const value: Allocation = {
      scope,
      name: 'ci-jit-' + id,
      job: notice,
      createdAt: Date.now(),
      box: { phase: 'none', id: null },
      runner: { phase: 'none', id: null },
      delivery: 'none',
      closing: false,
      effect: null,
    }
    // Touch the global index even when its keys do not change: cross-scope quota
    // admission must conflict with every concurrent reservation or release.
    const rows = await this.state.commit(
      lease,
      [
        { key: 'catalog/scopes', expected: snapshot.index.version, payload: snapshot.index.payload },
        {
          key: scope,
          expected: target.record.version,
          payload: json({ scope: target.scope, active: [...target.active, key] }),
        },
        { key, expected: null, payload: json(value) },
      ],
      policy.checks,
    )
    return { record: rows.find((row) => row.key === key)!, value }
  }
  /** A no-creation proof retires the original intent; unknown creates cannot use this path. */
  async rejectCreation(lease: ExecutionLease, key: string, version: string, effect: string): Promise<void> {
    lease = { ...lease }
    const snapshot = await this.load(lease),
      row = snapshot.allocations.get(key)
    if (!row || row.record.version !== version) throw new StateConflict()
    const value = row.value
    if (
      value.box.phase !== 'requested' ||
      value.box.id !== null ||
      value.runner.phase !== 'none' ||
      value.delivery !== 'none' ||
      value.effect?.kind !== 'box-create' ||
      value.effect.id !== effect
    )
      throw new Error('CI creation rejection does not match the original operation')
    const scope = snapshot.scopes.get(value.scope)!
    await this.state.commit(lease, [
      { key: 'catalog/scopes', expected: snapshot.index.version, payload: snapshot.index.payload },
      {
        key: scope.record.key,
        expected: scope.record.version,
        payload: json({ scope: scope.scope, active: scope.active.filter((item) => item !== key) }),
      },
      { key, expected: version },
    ])
  }
  async advance(lease: ExecutionLease, key: string, version: string, change: AllocationChange): Promise<AllocationRow> {
    lease = { ...lease }
    change = structuredClone(change)
    if (Object.keys(change).some((key) => !['box', 'runner', 'delivery', 'closing', 'effect'].includes(key)))
      throw new Error('Invalid allocation change')
    const [row] = await this.state.read([key])
    if (!row || row.version !== version) throw new StateConflict()
    const previous = decodeAllocation(row.payload),
      value = decodeAllocation({ ...previous, ...change })
    for (const kind of ['box', 'runner'] as const) {
      const old = previous[kind],
        next = value[kind]
      if (old.id !== null && next.id !== old.id) throw new Error('Original CI resource identity cannot change')
      const allowed = {
        none: ['none', 'requested', 'absent'],
        requested: ['requested', 'known'],
        known: ['known', 'absent'],
        absent: ['absent'],
      }
      if (!allowed[old.phase].includes(next.phase)) throw new Error('CI resource intent cannot be replayed')
    }
    const delivery = { none: ['none', 'requested'], requested: ['requested', 'done'], done: ['done'] }
    if (!delivery[previous.delivery].includes(value.delivery) || (previous.closing && !value.closing))
      throw new Error('CI allocation cannot move backwards')
    const [record] = await this.state.commit(lease, [{ key, expected: version, payload: json(value) }])
    return { record, value }
  }
  async release(lease: ExecutionLease, key: string, version: string): Promise<void> {
    lease = { ...lease }
    const snapshot = await this.load(lease),
      allocation = snapshot.allocations.get(key)
    if (!allocation || allocation.record.version !== version) throw new StateConflict()
    if (allocation.value.box.phase !== 'absent' || allocation.value.runner.phase !== 'absent')
      throw new Error('Original CI resources require confirmed cleanup')
    const scope = snapshot.scopes.get(allocation.value.scope)!
    await this.state.commit(lease, [
      { key: 'catalog/scopes', expected: snapshot.index.version, payload: snapshot.index.payload },
      {
        key: scope.record.key,
        expected: scope.record.version,
        payload: json({ scope: scope.scope, active: scope.active.filter((item) => item !== key) }),
      },
      { key, expected: version },
    ])
  }
}
