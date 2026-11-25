/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHash, randomUUID } from 'node:crypto'
import { JobNotice } from '../jobs'
import { Json, StateConflict, StateCorrupt, StateRecord } from '../state/database'
import { ExecutionLease, ListenerState, StateChange, StateCheck } from '../state/store'
import {
  Allocation,
  decodeAllocation,
  decodeScope,
  ExecutionScope,
  object,
  positive,
  retryCapacity,
  scopeKey,
} from './model'
import { CapacityPolicy, captureCapacity } from '../capacity'

interface ScopeRow {
  record: StateRecord
  scope: ExecutionScope
  activity: StateRecord
  index?: StateRecord
  active: number
}
export interface AllocationRow {
  record: StateRecord
  value: Allocation
}
interface Usage {
  id: string
  marker?: StateRecord
  record?: StateRecord
  used: number
}
interface Page<T> {
  rows: T[]
  after: string
}
export type AllocationChange = Partial<Pick<Allocation, 'box' | 'runner' | 'delivery' | 'closing' | 'effect'>>
const json = (value: unknown) => value as Json
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const domains = (scope: ExecutionScope) => ({
  global: 'global',
  organization: 'organization/' + hash(scope.organization),
  account: 'account/' + scope.installation.account.id,
})
const scopeId = (key: string) => {
  if (!/^scope\/[a-f0-9]{64}$/.test(key)) throw new StateCorrupt()
  return key.slice(6)
}
const workerId = (key: string) => {
  if (!/^worker\/[a-f0-9]{32}$/.test(key)) throw new StateCorrupt()
  return key.slice(7)
}
const jobKey = (scope: ExecutionScope, job: JobNotice) => `job/${scope.installation.id}/${job.repository}/${job.job}`
const allocationLink = (scope: ExecutionScope, value: Allocation) =>
  value.supply ? 'supply/' + value.name.slice(7) : jobKey(scope, value.job!)
const count = (record: StateRecord | undefined, field: string): number => {
  if (
    !record ||
    !object(record.payload) ||
    !Number.isSafeInteger(record.payload[field]) ||
    (record.payload[field] as number) < 0
  )
    throw new StateCorrupt()
  return record.payload[field] as number
}

/** Historical scopes are point references; only outstanding work has recovery memberships. */
export class ExecutionJournal {
  private readonly quotaWrites = new Map<string, Promise<void>>()
  private async serializeQuota<T>(organization: string, work: () => Promise<T>): Promise<T> {
    const previous = this.quotaWrites.get(organization) ?? Promise.resolve()
    const result = previous.then(work)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.quotaWrites.set(organization, tail)
    try {
      return await result
    } finally {
      if (this.quotaWrites.get(organization) === tail) this.quotaWrites.delete(organization)
    }
  }
  constructor(private readonly state: ListenerState) {}

  async initialize(initial: { key: string; payload: Json }[] = []): Promise<void> {
    // Existing namespaces missing this seed are rejected, never upgraded in place.
    await this.state.initialize([{ key: 'journal/format', payload: { version: 2 } }, ...initial])
    await this.check()
  }

  async check(lease?: ExecutionLease): Promise<void> {
    const [row] = await this.state.read(['journal/format'], lease)
    if (!row || !object(row.payload) || row.payload.version !== 2) throw new StateCorrupt()
  }

  async scope(lease: ExecutionLease, key: string): Promise<ScopeRow> {
    lease = { ...lease }
    const id = scopeId(key)
    await this.check(lease)
    const records = new Map(
      (await this.state.read([key, 'scope-state/' + id, 'active-scope/' + id], lease)).map((row) => [row.key, row]),
    )
    const record = records.get(key)
    if (!record || !object(record.payload)) throw new StateCorrupt()
    const scope = decodeScope(record.payload.scope)
    if (scopeKey(scope) !== key) throw new StateCorrupt()
    const activity = records.get('scope-state/' + id),
      index = records.get('active-scope/' + id)
    const active = count(activity, 'active')
    if (active ? count(index, 'active') !== active : index !== undefined) throw new StateCorrupt()
    const application = record.payload.application
    if (application !== null) {
      if (typeof application !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(application)) throw new StateCorrupt()
      const [mapping] = await this.state.read(['app-scope/' + id], lease)
      if (!mapping || !object(mapping.payload) || mapping.payload.application !== application) throw new StateCorrupt()
    }
    await this.usage(Object.values(domains(scope)), lease)
    return { record, scope, activity: activity!, index, active }
  }

  async define(lease: ExecutionLease, definition: ExecutionScope, application?: string): Promise<string> {
    lease = { ...lease }
    const scope = decodeScope(definition),
      key = scopeKey(scope),
      id = scopeId(key)
    if (application !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(application)) throw new StateCorrupt()
    await this.check(lease)
    const [existing] = await this.state.read([key], lease)
    if (existing) {
      const row = await this.scope(lease, key)
      if (application !== undefined && (!object(row.record.payload) || row.record.payload.application !== application))
        throw new StateCorrupt()
      return key
    }
    const usage = await this.usage(Object.values(domains(scope)), lease, true)
    const changes: StateChange[] = [
      { key, expected: null, payload: json({ scope, application: application ?? null }) },
      { key: 'scope-state/' + id, expected: null, payload: { active: 0 } },
    ]
    for (const value of usage)
      if (!value.record) {
        changes.push(
          { key: 'domain/' + value.id, expected: null, payload: { id: value.id } },
          { key: 'usage/' + value.id, expected: null, payload: { used: 0 } },
        )
      }
    if (application !== undefined) changes.push({ key: 'app-scope/' + id, expected: null, payload: { application } })
    await this.state.commit(lease, changes)
    return key
  }

  /** A bounded recovery page; the caller retains its cursor across cycles. */
  async activeScopes(lease: ExecutionLease, after = '', limit = 8): Promise<Page<ScopeRow>> {
    lease = { ...lease }
    await this.check(lease)
    const records = await this.state.scan(lease, { prefix: 'active-scope/', after, limit })
    const rows: ScopeRow[] = []
    for (const record of records) {
      const row = await this.scope(lease, 'scope/' + record.key.slice('active-scope/'.length))
      // A concurrent final release can remove membership after the page snapshot.
      if (row.active) rows.push(row)
    }
    return { rows, after: records.length === limit ? records[records.length - 1].key : '' }
  }

  async workers(lease: ExecutionLease, scope: string, after = '', limit = 32): Promise<Page<AllocationRow>> {
    lease = { ...lease }
    const target = await this.scope(lease, scope)
    const prefix = 'active-worker/' + scopeId(scope) + '/'
    const records = await this.state.scan(lease, { prefix, after, limit })
    const rows: AllocationRow[] = []
    for (let offset = 0; offset < records.length; offset += 32) {
      const batch = records.slice(offset, offset + 32)
      const keys = batch.map((record) => 'worker/' + record.key.slice(prefix.length))
      const initial = await this.state.read(keys, lease)
      const current = await this.readAllocations(lease, target, initial)
      const found = new Set(current.map((row) => row.record.key))
      const missing = batch.filter((_, index) => !found.has(keys[index])).map((row) => row.key)
      // A final release can remove a worker between the page and point reads.
      if (missing.length && (await this.state.read(missing, lease)).length) throw new StateCorrupt()
      rows.push(...current)
    }
    return { rows, after: records.length === limit ? records[records.length - 1].key : '' }
  }

  async allocation(lease: ExecutionLease, key: string): Promise<AllocationRow | undefined> {
    lease = { ...lease }
    workerId(key)
    await this.check(lease)
    const [first] = await this.state.read([key], lease)
    if (!first) return undefined
    const scope = await this.scope(lease, decodeAllocation(first.payload).scope)
    return (await this.readAllocations(lease, scope, [first]))[0]
  }

  private async readAllocations(
    lease: ExecutionLease,
    scope: ScopeRow,
    initial: readonly StateRecord[],
  ): Promise<AllocationRow[]> {
    if (!initial.length) return []
    const originals = initial.map((record) => {
      const value = decodeAllocation(record.payload)
      if (value.scope !== scope.record.key) throw new StateCorrupt()
      const membership = 'active-worker/' + scopeId(value.scope) + '/' + workerId(record.key)
      return { record, value, membership, dedupe: allocationLink(scope.scope, value) }
    })
    // Each allocation contributes at most three keys to one fenced snapshot.
    const records = new Map(
      (
        await this.state.read(
          [...new Set(originals.flatMap((row) => [row.record.key, row.membership, row.dedupe]))],
          lease,
        )
      ).map((row) => [row.key, row]),
    )
    const result: AllocationRow[] = []
    for (const original of originals) {
      const record = records.get(original.record.key)
      if (!record) continue
      const value = decodeAllocation(record.payload)
      if (
        value.name !== 'ci-jit-' + workerId(record.key) ||
        value.scope !== original.value.scope ||
        allocationLink(scope.scope, value) !== original.dedupe
      )
        throw new StateCorrupt()
      for (const link of [original.membership, original.dedupe]) {
        const row = records.get(link)
        if (!row || !object(row.payload) || row.payload.worker !== record.key) throw new StateCorrupt()
      }
      result.push({ record, value })
    }
    return result
  }

  async hasCapacity(lease: ExecutionLease, scope: string, policy: CapacityPolicy): Promise<boolean> {
    return (await this.remainingCapacity(lease, scope, policy)) > 0
  }
  async remainingCapacity(lease: ExecutionLease, scope: string, policy: CapacityPolicy): Promise<number> {
    return Math.max(0, await this.capacityMargin(lease, scope, captureCapacity(policy)))
  }
  /** A retry reuses its original charge. A lowered limit still applies to acquiring new work. */
  async permitsChargedRetry(lease: ExecutionLease, scope: string, policy: CapacityPolicy): Promise<boolean> {
    policy = captureCapacity(policy)
    return !policy.limits.some((limit) => limit.maximum === 0) && (await this.capacityMargin(lease, scope, policy)) >= 0
  }
  private async capacityMargin(lease: ExecutionLease, scope: string, policy: CapacityPolicy): Promise<number> {
    lease = { ...lease }
    const ids = domains((await this.scope(lease, scope)).scope)
    const usage = await this.usage(Object.values(ids), lease)
    let free = 2_147_483_647
    for (const { maximum, domain } of policy.limits) {
      if (maximum !== null) free = Math.min(free, maximum - usage.find((row) => row.id === ids[domain])!.used)
    }
    return free
  }
  /** Dashboard aggregate: an entirely new domain has no usage; a broken pair is corruption. */
  async used(organization: string): Promise<number> {
    if (!organization || organization.length > 128) throw new Error('Invalid CI capacity organization')
    await this.check()
    return (await this.usage(['organization/' + hash(organization)], undefined, true))[0].used
  }

  async reserve(
    lease: ExecutionLease,
    scope: string,
    notice: JobNotice | null,
    policy: CapacityPolicy,
    supply?: Allocation['supply'],
  ): Promise<AllocationRow | undefined> {
    lease = { ...lease }
    notice = notice && { ...notice }
    policy = captureCapacity(policy)
    supply = supply ? { ...supply, labels: [...supply.labels] } : undefined
    const target = await this.scope(lease, scope)
    return this.serializeQuota(target.scope.organization, () =>
      this.reserveCapacity(lease, scope, notice, policy, supply),
    )
  }
  private async reserveCapacity(
    lease: ExecutionLease,
    scope: string,
    notice: JobNotice | null,
    policy: CapacityPolicy,
    supply?: Allocation['supply'],
  ): Promise<AllocationRow | undefined> {
    lease = { ...lease }
    notice = notice && { ...notice }
    policy = captureCapacity(policy)
    if (
      notice
        ? !positive(notice.repository) ||
          !positive(notice.run) ||
          !positive(notice.job) ||
          supply?.scaleSet !== undefined
        : !positive(supply?.scaleSet)
    )
      throw new Error('Invalid CI admission request')
    const target = await this.scope(lease, scope),
      runner = target.scope.runners
    if (
      notice &&
      (runner.kind === 'repository'
        ? runner.repository.id !== notice.repository
        : !runner.repositories.includes(notice.repository))
    )
      throw new Error('CI job is outside its execution scope')
    supply = supply ? { ...supply, labels: [...supply.labels] } : undefined
    const dedupe = notice && !supply ? jobKey(target.scope, notice) : undefined,
      [previous] = dedupe ? await this.state.read([dedupe], lease) : []
    if (previous) {
      if (!object(previous.payload) || typeof previous.payload.worker !== 'string') throw new StateCorrupt()
      const allocation = await this.allocation(lease, previous.payload.worker)
      if (!allocation) throw new StateCorrupt()
      const original = await this.scope(lease, allocation.value.scope)
      if (!allocation.value.job || jobKey(original.scope, allocation.value.job) !== dedupe) throw new StateCorrupt()
      return undefined
    }
    const ids = domains(target.scope),
      usage = await this.usage(Object.values(ids), lease)
    if (
      !policy.limits.every(
        ({ maximum, domain }) => maximum === null || usage.find((row) => row.id === ids[domain])!.used < maximum,
      )
    )
      return undefined
    const id = randomUUID().replaceAll('-', ''),
      key = 'worker/' + id
    const value: Allocation = {
      scope,
      name: 'ci-jit-' + id,
      job: notice,
      ...(supply ? { supply } : {}),
      createdAt: Date.now(),
      box: { phase: 'none', id: null },
      runner: { phase: 'none', id: null },
      delivery: 'none',
      closing: false,
      effect: null,
    }
    decodeAllocation(value)
    const rows = await this.state.commit(
      lease,
      [
        ...this.activity(target, 1),
        ...this.charge(usage, 1),
        { key, expected: null, payload: json(value) },
        { key: allocationLink(target.scope, value), expected: null, payload: { worker: key } },
        { key: 'active-worker/' + scopeId(scope) + '/' + id, expected: null, payload: { worker: key } },
      ],
      [{ key: target.record.key, version: target.record.version }, ...(policy.checks ?? [])],
    )
    return { record: rows.find((row) => row.key === key)!, value }
  }

  /** Only an original no-creation proof can retire an uncertain create intent. */
  async rejectCreation(lease: ExecutionLease, key: string, version: string, effect: string): Promise<void> {
    lease = { ...lease }
    const row = await this.allocation(lease, key)
    if (!row) throw new StateConflict()
    const target = await this.scope(lease, row.value.scope)
    return this.serializeQuota(target.scope.organization, () => this.rejectCapacity(lease, key, version, effect))
  }
  private async rejectCapacity(lease: ExecutionLease, key: string, version: string, effect: string): Promise<void> {
    lease = { ...lease }
    const row = await this.allocation(lease, key)
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
    await this.remove(lease, row, true)
  }

  async advance(
    lease: ExecutionLease,
    key: string,
    version: string,
    change: AllocationChange,
    checks: readonly StateCheck[] = [],
  ): Promise<AllocationRow> {
    lease = { ...lease }
    change = structuredClone(change)
    if (change.box?.phase !== 'absent') return this.advanceRecord(lease, key, version, change, checks)
    const row = await this.allocation(lease, key)
    if (!row) throw new StateConflict()
    const target = await this.scope(lease, row.value.scope)
    return this.serializeQuota(target.scope.organization, () => this.advanceRecord(lease, key, version, change, checks))
  }
  private async advanceRecord(
    lease: ExecutionLease,
    key: string,
    version: string,
    change: AllocationChange,
    checks: readonly StateCheck[],
  ): Promise<AllocationRow> {
    lease = { ...lease }
    change = structuredClone(change)
    if (Object.keys(change).some((key) => !['box', 'runner', 'delivery', 'closing', 'effect'].includes(key)))
      throw new Error('Invalid allocation change')
    const row = await this.allocation(lease, key)
    if (!row || row.record.version !== version) throw new StateConflict()
    const previous = row.value,
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
    const changes: StateChange[] = [{ key, expected: version, payload: json(value) }]
    const released = previous.box.phase !== 'absent' && value.box.phase === 'absent'
    const capacityChanged = retryCapacity(previous) !== retryCapacity(value)
    let refreshScopeActivity: string | undefined
    if (released || capacityChanged) {
      const target = await this.scope(lease, value.scope)
      // Sibling workers each own a slot. Only acquisition retries depend on the old aggregate version.
      if (capacityChanged) refreshScopeActivity = target.activity.key
      if (released) changes.push(...this.charge(await this.usage(Object.values(domains(target.scope)), lease), -1))
    }
    const records = await this.state.commit(lease, changes, checks, refreshScopeActivity)
    return { record: records.find((record) => record.key === key)!, value }
  }

  async release(lease: ExecutionLease, key: string, version: string): Promise<void> {
    lease = { ...lease }
    const row = await this.allocation(lease, key)
    if (!row) throw new StateConflict()
    const target = await this.scope(lease, row.value.scope)
    return this.serializeQuota(target.scope.organization, () => this.releaseRecord(lease, key, version))
  }
  private async releaseRecord(lease: ExecutionLease, key: string, version: string): Promise<void> {
    lease = { ...lease }
    const row = await this.allocation(lease, key)
    if (!row || row.record.version !== version) throw new StateConflict()
    if (row.value.box.phase !== 'absent' || row.value.runner.phase !== 'absent')
      throw new Error('Original CI resources require confirmed cleanup')
    await this.remove(lease, row, false)
  }

  private async remove(lease: ExecutionLease, row: AllocationRow, occupied: boolean): Promise<void> {
    const scope = await this.scope(lease, row.value.scope)
    const keys = [
      allocationLink(scope.scope, row.value),
      'active-worker/' + scopeId(row.value.scope) + '/' + workerId(row.record.key),
    ]
    const links = await this.state.read(keys, lease)
    if (
      links.length !== keys.length ||
      links.some((link) => !object(link.payload) || link.payload.worker !== row.record.key)
    )
      throw new StateCorrupt()
    const changes: StateChange[] = [
      ...this.activity(scope, -1),
      ...links.map((link) => ({ key: link.key, expected: link.version })),
      { key: row.record.key, expected: row.record.version },
    ]
    if (occupied) changes.push(...this.charge(await this.usage(Object.values(domains(scope.scope)), lease), -1))
    await this.state.commit(lease, changes)
  }

  private activity(scope: ScopeRow, delta: number): StateChange[] {
    const active = scope.active + delta
    if (!Number.isSafeInteger(active) || active < 0) throw new StateCorrupt()
    return [
      { key: scope.activity.key, expected: scope.activity.version, payload: { active } },
      active
        ? {
            key: 'active-scope/' + scopeId(scope.record.key),
            expected: scope.index?.version ?? null,
            payload: { active },
          }
        : { key: 'active-scope/' + scopeId(scope.record.key), expected: scope.index!.version },
    ]
  }

  private async usage(ids: string[], lease?: ExecutionLease, fresh = false): Promise<Usage[]> {
    const rows = new Map(
      (
        await this.state.read(
          ids.flatMap((id) => ['domain/' + id, 'usage/' + id]),
          lease,
        )
      ).map((row) => [row.key, row]),
    )
    return ids.map((id) => {
      const marker = rows.get('domain/' + id),
        record = rows.get('usage/' + id)
      if (!marker && !record && fresh) return { id, used: 0 }
      if (!marker || !object(marker.payload) || marker.payload.id !== id) throw new StateCorrupt()
      return { id, marker, record, used: count(record, 'used') }
    })
  }

  private charge(usage: Usage[], delta: number): StateChange[] {
    return usage.map((row) => {
      const used = row.used + delta
      if (!row.record || !Number.isSafeInteger(used) || used < 0) throw new StateCorrupt()
      return { key: row.record.key, expected: row.record.version, payload: { used } }
    })
  }
}
