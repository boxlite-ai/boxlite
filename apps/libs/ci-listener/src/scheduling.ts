/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ExecutionScope, object, positive } from './execution/model'
import { StateCorrupt, StateRecord } from './state/database'
import { JobNotice } from './jobs'

export interface PendingJob {
  record: StateRecord
  installation: number
  account: number
  notice: JobNotice
}
export function pendingJob(record: StateRecord): PendingJob {
  const value = record.payload
  if (
    !object(value) ||
    !Number.isSafeInteger(value.installationId) ||
    (value.installationId as number) < 0 ||
    !positive(value.accountId) ||
    !positive(value.repositoryId) ||
    !object(value.job) ||
    !positive(value.job.id) ||
    !positive(value.job.runId) ||
    record.key !== `notice/${value.installationId}/${value.job.id}`
  )
    throw new StateCorrupt()
  return {
    record,
    installation: value.installationId as number,
    account: value.accountId,
    notice: { repository: value.repositoryId, job: value.job.id, run: value.job.runId },
  }
}
export function repositories(scope: ExecutionScope): number[] {
  return scope.runners.kind === 'repository' ? [scope.runners.repository.id] : [...scope.runners.repositories]
}
export function matches(scope: ExecutionScope, job: PendingJob): boolean {
  return (
    scope.installation.id === job.installation &&
    scope.installation.account.id === job.account &&
    repositories(scope).includes(job.notice.repository)
  )
}

/** Rotate tenants, then GitHub accounts, then jobs; a large repository list earns no extra turns. */
export class FairSelection {
  private tenant = 0
  private readonly account = new Map<string, number>()
  private readonly item = new Map<string, number>()
  take<T>(values: readonly { scope: ExecutionScope; value: T }[], limit: number): T[] {
    const tenants = new Map<string, Map<number, T[]>>()
    for (const { scope, value } of values) {
      const accounts = tenants.get(scope.organization) ?? new Map<number, T[]>(),
        id = scope.installation.account.id
      const items = accounts.get(id) ?? []
      items.push(value)
      accounts.set(id, items)
      tenants.set(scope.organization, accounts)
    }
    const names = [...tenants.keys()].sort(),
      result: T[] = [],
      used = new Set<string>()
    let misses = 0
    while (result.length < limit && names.length && misses < names.length) {
      const tenant = names[this.tenant++ % names.length],
        accounts = tenants.get(tenant)!,
        ids = [...accounts.keys()].sort((a, b) => a - b)
      let chosen: number | undefined
      for (let i = 0; i < ids.length; i++) {
        const cursor = this.account.get(tenant) ?? 0,
          id = ids[cursor % ids.length]
        this.account.set(tenant, cursor + 1)
        if (!used.has(`${tenant}/${id}`)) {
          chosen = id
          break
        }
      }
      if (chosen === undefined) {
        misses++
        continue
      }
      misses = 0
      const key = `${tenant}/${chosen}`,
        items = accounts.get(chosen)!,
        cursor = this.item.get(key) ?? 0
      result.push(items[cursor % items.length])
      this.item.set(key, cursor + 1)
      used.add(key)
    }
    return result
  }
}
