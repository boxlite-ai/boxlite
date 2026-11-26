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
