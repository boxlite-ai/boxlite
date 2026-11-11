/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { decodeAllocation, decodeScope, ExecutionScope, object } from '../src/execution/model'
import { AllocationRow } from '../src/execution/journal'
import { StateCorrupt, StateRecord } from '../src/state/database'
import { ExecutionLease, ListenerState } from '../src/state/store'

/** Test inspection only: assertions may inspect all persisted rows, production never does. */
export async function inspectJournal(state: ListenerState, lease: ExecutionLease) {
  const rows = await state.recover(lease, 100_000, ['scope/', 'worker/', 'active-worker/', 'usage/'])
  const scopes = new Map<string, { record: StateRecord; scope: ExecutionScope; active: string[] }>()
  const allocations = new Map<string, AllocationRow>()
  for (const record of rows) {
    if (record.key.startsWith('scope/')) {
      if (!object(record.payload)) throw new StateCorrupt()
      scopes.set(record.key, { record, scope: decodeScope(record.payload.scope), active: [] })
    }
    if (record.key.startsWith('worker/'))
      allocations.set(record.key, { record, value: decodeAllocation(record.payload) })
  }
  for (const record of rows.filter((row) => row.key.startsWith('active-worker/'))) {
    if (!object(record.payload) || typeof record.payload.worker !== 'string') throw new StateCorrupt()
    const scope = scopes.get('scope/' + record.key.split('/')[1])
    if (!scope) throw new StateCorrupt()
    scope.active.push(record.payload.worker)
  }
  return {
    scopes,
    allocations,
    usage: rows.filter((row) => row.key.startsWith('usage/')),
    workers: [...allocations.values()]
      .filter((row) => row.value.box.phase !== 'absent')
      .map((row) => scopes.get(row.value.scope)!.scope),
  }
}
