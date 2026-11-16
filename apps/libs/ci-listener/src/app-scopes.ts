/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ExecutionJournal } from './execution/journal'
import { decodeScope, ExecutionScope, object, scopeKey } from './execution/model'
import { StateCorrupt } from './state/database'
import { ExecutionLease, ListenerState } from './state/store'

/** Original App provenance outlives connect bindings and mutable admission roles. */
export class ScopeApplications {
  constructor(
    private readonly state: ListenerState,
    private readonly rootKey: string,
    private readonly original: string,
  ) {}
  async initialize(lease: ExecutionLease): Promise<void> {
    lease = { ...lease }
    await new ExecutionJournal(this.state).check(lease)
    const [root] = await this.state.read([this.rootKey], lease)
    if (
      !root ||
      root.schema !== 1 ||
      !object(root.payload) ||
      (root.payload.app !== this.original && root.payload.issuer !== this.original)
    )
      throw new StateCorrupt()
  }
  async application(lease: ExecutionLease, scope: ExecutionScope): Promise<string> {
    lease = { ...lease }
    scope = decodeScope(scope)
    await this.initialize(lease)
    const key = scopeKey(scope)
    await new ExecutionJournal(this.state).scope(lease, key)
    const [row] = await this.state.read(['app-scope/' + key.slice(6)], lease)
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
