/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ExecutionJournal } from './execution/journal'
import { decodeScope, ExecutionScope, object, scopeKey } from './execution/model'
import { StateCorrupt } from './state/database'
import { ExecutionLease, ListenerState, StateChange } from './state/store'

/** Original App provenance outlives connect bindings and mutable admission roles. */
export class ScopeApplications {
  constructor(
    private readonly state: ListenerState,
    private readonly rootKey: string,
    private readonly original: string,
  ) {}
  async initialize(lease: ExecutionLease): Promise<void> {
    lease = { ...lease }
    const [root] = await this.state.read([this.rootKey])
    const [marker] = await this.state.read(['apps/scopes-initialized'])
    if (
      !root ||
      root.schema !== 1 ||
      !object(root.payload) ||
      (root.payload.app !== this.original && root.payload.issuer !== this.original)
    )
      throw new StateCorrupt()
    if (root.payload.appScopeVersion === 1) {
      if (!marker || !object(marker.payload) || marker.payload.original !== this.original) throw new StateCorrupt()
      return
    }
    if (root.payload.appScopeVersion !== undefined || marker) throw new StateCorrupt()
    const snapshot = await new ExecutionJournal(this.state).load(lease)
    const keys = [...snapshot.scopes.keys()].map((key) => 'app-scope/' + key.slice(6))
    for (let start = 0; start < keys.length; start += 99) {
      const batch = keys.slice(start, start + 99),
        records = new Map((await this.state.read(batch)).map((row) => [row.key, row]))
      const changes: StateChange[] = []
      for (const key of batch) {
        const row = records.get(key)
        if (row && (!object(row.payload) || row.payload.application !== this.original)) throw new StateCorrupt()
        if (!row) changes.push({ key, expected: null, payload: { application: this.original } })
      }
      if (changes.length) await this.state.commit(lease, changes)
    }
    await this.state.commit(lease, [
      { key: this.rootKey, expected: root.version, payload: { ...root.payload, appScopeVersion: 1 } },
      { key: 'apps/scopes-initialized', expected: null, payload: { original: this.original } },
    ])
  }
  async application(lease: ExecutionLease, scope: ExecutionScope): Promise<string> {
    lease = { ...lease }
    scope = decodeScope(scope)
    await this.initialize(lease)
    const snapshot = await new ExecutionJournal(this.state).load(lease),
      key = scopeKey(scope)
    if (!snapshot.scopes.has(key)) throw new StateCorrupt()
    const [row] = await this.state.read(['app-scope/' + key.slice(6)])
    if (
      !row ||
      !object(row.payload) ||
      typeof row.payload.application !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(row.payload.application)
    )
      throw new StateCorrupt()
    return row.payload.application
  }
  async define(lease: ExecutionLease, scope: ExecutionScope, application: string): Promise<string> {
    lease = { ...lease }
    scope = decodeScope(scope)
    await this.initialize(lease)
    return new ExecutionJournal(this.state).define(lease, scope, application)
  }
}
