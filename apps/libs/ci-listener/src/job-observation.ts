/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Json, StateCorrupt } from './state/database'
import { IngressTransaction, StateChange } from './state/store'
import { object, positive } from './execution/model'
import type { WakeHint } from './webhook'

export interface JobObservation {
  status: 'queued' | 'in_progress' | 'completed'
  labels: string[]
  runner: number | null
}
const rank = { queued: 0, in_progress: 1, completed: 2 }
export class JobIdentityConflict extends Error {}

export async function recordJobObservation(
  tx: IngressTransaction,
  hint: WakeHint,
  supplied: JobObservation,
): Promise<StateChange[]> {
  if (!hint.job) throw new StateCorrupt()
  if (
    !['queued', 'in_progress', 'completed'].includes(supplied.status) ||
    !Array.isArray(supplied.labels) ||
    supplied.labels.some((label) => typeof label !== 'string' || !label || label.length > 128) ||
    supplied.labels.length > 100
  )
    throw new StateCorrupt()
  const observation = { ...supplied, labels: [...new Set(supplied.labels.map((label) => label.toLowerCase()))].sort() }
  if (observation.runner !== null && !positive(observation.runner)) throw new StateCorrupt()
  const jobId = hint.job.id
  const factKey = `job-fact/${hint.installationId}/${jobId}`
  const [prior] = await tx.read([factKey])
  let previous: JobObservation | undefined
  if (prior) {
    const value = prior.payload
    if (
      !object(value) ||
      !object(value.hint) ||
      !object(value.hint.job) ||
      typeof value.status !== 'string' ||
      !['queued', 'in_progress', 'completed'].includes(value.status) ||
      !Array.isArray(value.labels) ||
      !value.labels.every((label) => typeof label === 'string')
    )
      throw new StateCorrupt()
    if (
      value.hint.repositoryId !== hint.repositoryId ||
      value.hint.accountId !== hint.accountId ||
      value.hint.job.id !== hint.job.id ||
      value.hint.job.runId !== hint.job.runId
    )
      throw new JobIdentityConflict('Job identity conflicts with its recorded observation')
    previous = {
      status: value.status as JobObservation['status'],
      labels: value.labels as string[],
      runner: value.runner as number | null,
    }
    if (rank[observation.status] <= rank[previous.status]) return []
    if (!observation.labels.length) observation.labels = [...previous.labels]
  }
  return [{ key: factKey, expected: prior?.version ?? null, payload: { ...observation, hint } as unknown as Json }]
}
