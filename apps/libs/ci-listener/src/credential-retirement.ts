/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ExecutionLease, ListenerState } from './state/store'
import { StateCorrupt, StateRecord } from './state/database'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const operation = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const key = new RegExp('^credential/[A-Za-z0-9][A-Za-z0-9:._/-]{0,149}/(' + operation + ')$')

/** Collects metadata only; it owns no token and cannot release resource quota. */
export class CredentialCollector {
  private after = ''
  constructor(private readonly state: ListenerState) {}

  async step(original: ExecutionLease): Promise<void> {
    const lease = { ...original }
    const rows = await this.state.scan(lease, { prefix: 'credential/', after: this.after, limit: 16 })
    // Scan credentials use their own claim and expiration index.
    const candidates = rows.filter((row) => !row.key.startsWith('credential/scan/'))
    if (candidates.length) {
      const now = await this.state.now(lease)
      const changes = candidates
        .filter((row) => this.expired(row, lease, now))
        .map(({ key, version }) => ({ key, expected: version }))
      if (changes.length) await this.state.commit(lease, changes)
    }
    this.after = rows.length === 16 ? rows[rows.length - 1].key : ''
  }

  private expired(row: StateRecord, lease: ExecutionLease, now: number): boolean {
    const id = key.exec(row.key)?.[1]
    const value = row.payload
    if (
      !id ||
      row.schema !== 1 ||
      !object(value) ||
      value.operation !== id ||
      !Number.isSafeInteger(value.installation) ||
      Number(value.installation) < 0 ||
      !positive(value.requestedAt) ||
      !object(value.purpose) ||
      typeof value.purpose.kind !== 'string' ||
      !['catalog', 'jobs', 'repository-runners', 'organization-runners'].includes(value.purpose.kind) ||
      (['jobs', 'repository-runners'].includes(value.purpose.kind) && !positive(value.purpose.repository)) ||
      typeof value.phase !== 'string' ||
      !['requested', 'issued'].includes(value.phase)
    )
      throw new StateCorrupt()
    const holder = value.holder
    if (
      holder !== undefined &&
      (!object(holder) ||
        typeof holder.owner !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(holder.owner) ||
        !positive(holder.epoch) ||
        (holder.deployment !== undefined && !positive(holder.deployment)))
    )
      throw new StateCorrupt()
    if (
      object(holder) &&
      holder.owner === lease.owner &&
      holder.epoch === lease.epoch &&
      holder.deployment === lease.deployment
    )
      return false
    if (
      object(holder) &&
      (Number(holder.epoch) >= lease.epoch || Number(holder.deployment ?? 0) > (lease.deployment ?? 0))
    )
      return false
    if (value.phase !== 'issued') return false
    // An expired App token needs no surviving revocation handle. Unknown issue
    // outcomes and legacy PAT borrows have no equivalent expiry proof.
    if (Number(value.installation) > 0)
      return positive(value.expiresAt) && value.expiresAt > value.requestedAt && value.expiresAt <= now
    return value.expiresAt === null && object(holder)
  }
}
