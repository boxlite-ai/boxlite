/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHash } from 'node:crypto'
import { Json, StateCorrupt, StateRecord } from './state/database'
import { ExecutionLease, IngressTransaction, ListenerState, StateChange } from './state/store'
import { object, positive } from './execution/model'
import type { WakeHint } from './webhook'
import type { WorkflowJob } from './jobs'
import { StateConflict } from './state/database'

export interface JobObservation {
  status: 'queued' | 'in_progress' | 'completed'
  labels: string[]
  runner: number | null
}
export interface LabelDemand {
  /** Snapshot fences are transport metadata and are never persisted in the counter payload. */
  key?: string
  version?: string
  installationId: number
  accountId: number
  repositoryId: number
  labels: string[]
  queued: number
  dirty: boolean
  updatedAt: number
  job: { id: number; runId: number }
}
const rank = { queued: 0, in_progress: 1, completed: 2 }
export class DemandUncertain extends Error {}
export class DemandIdentityConflict extends Error {}
const labelsFor = (labels: readonly string[]) => [...new Set(labels.map((label) => label.toLowerCase()))].sort()
export const demandKey = (installation: number, repository: number, labels: readonly string[]) =>
  `demand/${installation}/${repository}/` +
  createHash('sha256')
    .update(JSON.stringify(labelsFor(labels)))
    .digest('hex')

export function decodeDemand(row: StateRecord): LabelDemand {
  const value = row.payload
  if (
    row.schema !== 1 ||
    !object(value) ||
    !positive(value.installationId) ||
    !positive(value.accountId) ||
    !positive(value.repositoryId) ||
    !Array.isArray(value.labels) ||
    !value.labels.length ||
    value.labels.length > 100 ||
    !value.labels.every((label) => typeof label === 'string' && label.length > 0 && label.length <= 128) ||
    !Number.isSafeInteger(value.queued) ||
    (value.queued as number) < 0 ||
    typeof value.dirty !== 'boolean' ||
    !Number.isSafeInteger(value.updatedAt) ||
    !object(value.job) ||
    !positive(value.job.id) ||
    !positive(value.job.runId) ||
    row.key !== demandKey(value.installationId, value.repositoryId, value.labels as string[])
  )
    throw new StateCorrupt()
  return {
    ...value,
    labels: [...value.labels],
    job: { ...value.job },
    key: row.key,
    version: row.version,
  } as unknown as LabelDemand
}

/** One ingress transaction owns event idempotency and aggregate demand together. */
export async function observeDemand(
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
  const observation = { ...supplied, labels: labelsFor(supplied.labels) }
  if (observation.runner !== null && !positive(observation.runner)) throw new StateCorrupt()
  const factKey = `job-fact/${hint.installationId}/${hint.job.id}`
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
      throw new DemandIdentityConflict('Job identity conflicts with its recorded observation')
    previous = {
      status: value.status as JobObservation['status'],
      labels: value.labels as string[],
      runner: value.runner as number | null,
    }
    if (rank[observation.status] <= rank[previous.status]) return []
    if (!observation.labels.length) observation.labels = [...previous.labels]
  }
  const deltas = new Map<string, { labels: string[]; delta: number }>()
  if (previous?.status === 'queued')
    deltas.set(demandKey(hint.installationId, hint.repositoryId, previous.labels), {
      labels: previous.labels,
      delta: -1,
    })
  if (observation.status === 'queued') {
    if (!observation.labels.length) throw new StateCorrupt()
    const key = demandKey(hint.installationId, hint.repositoryId, observation.labels)
    deltas.set(key, { labels: observation.labels, delta: (deltas.get(key)?.delta ?? 0) + 1 })
  }
  const changes: StateChange[] = [
    {
      key: factKey,
      expected: prior?.version ?? null,
      payload: { ...observation, hint } as unknown as Json,
    },
  ]
  if (observation.status !== 'queued' && observation.runner !== null) {
    const key = `runner-claim/${hint.installationId}/${observation.runner}`
    const [claim] = await tx.read([key])
    if (
      claim &&
      (!object(claim.payload) ||
        !positive(claim.payload.repository) ||
        !positive(claim.payload.run) ||
        !positive(claim.payload.job) ||
        !['in_progress', 'completed'].includes(claim.payload.status as string) ||
        (claim.payload.ambiguous !== undefined && typeof claim.payload.ambiguous !== 'boolean'))
    )
      throw new StateCorrupt()
    const priorClaim = claim?.payload as Record<string, Json> | undefined
    const sameJob =
      !priorClaim ||
      (priorClaim.repository === hint.repositoryId &&
        priorClaim.run === hint.job.runId &&
        priorClaim.job === hint.job.id)
    // Delivery order cannot establish which reused-runner assignment is current.
    // Accept facts, but require a queue scan for ambiguous busy supply.
    if (sameJob || observation.status === 'in_progress')
      changes.push({
        key,
        expected: claim?.version ?? null,
        payload: {
          repository: hint.repositoryId,
          run: hint.job.runId,
          job: hint.job.id,
          status: observation.status,
          ...(!sameJob || priorClaim?.ambiguous ? { ambiguous: true } : {}),
        },
      })
  }
  for (const [key, { labels, delta }] of deltas) {
    const [row] = await tx.read([key])
    const old = row ? decodeDemand(row) : undefined
    const queued = (old?.queued ?? 0) + delta
    const value: LabelDemand = {
      installationId: hint.installationId,
      accountId: hint.accountId,
      repositoryId: hint.repositoryId,
      labels,
      queued: Math.max(0, queued),
      dirty: (old?.dirty ?? false) || queued < 0,
      updatedAt: Date.now(),
      job: { ...hint.job },
    }
    changes.push({ key, expected: row?.version ?? null, payload: value as unknown as Json })
  }
  return changes
}

/** Replace a suspect count only if no webhook arrived during its authoritative scan. */
export async function rebuildDemand(
  state: ListenerState,
  lease: ExecutionLease,
  target: Pick<LabelDemand, 'installationId' | 'accountId' | 'repositoryId'>,
  previous: readonly StateRecord[],
  jobs: readonly WorkflowJob[],
  wakeVersion?: string,
): Promise<StateRecord[]> {
  const prefix = `demand/${target.installationId}/${target.repositoryId}/`
  const wakeKey = `wake/${target.installationId}/${target.repositoryId}`
  return state.ingress(
    `${target.installationId}/${target.repositoryId}`,
    async (tx) => {
      const [wake] = await tx.read([wakeKey])
      if (wake?.version !== wakeVersion) throw new StateConflict()
      const counts = new Map<string, { labels: string[]; jobs: WorkflowJob[] }>()
      for (const job of jobs) {
        if (job.repository !== target.repositoryId || job.status !== 'queued' || job.runner !== null) continue
        const factKey = `job-fact/${target.installationId}/${job.job}`
        const [fact] = await tx.read([factKey])
        if (fact && object(fact.payload) && ['in_progress', 'completed'].includes(fact.payload.status as string))
          continue
        if (!fact)
          await tx.write([
            {
              key: factKey,
              expected: null,
              payload: {
                status: 'queued',
                labels: labelsFor(job.labels),
                runner: null,
                hint: { ...target, job: { id: job.job, runId: job.run } },
              },
            },
          ])
        const key = demandKey(target.installationId, target.repositoryId, job.labels)
        const entry = counts.get(key) ?? { labels: labelsFor(job.labels), jobs: [] }
        entry.jobs.push(job)
        counts.set(key, entry)
      }
      const known = previous.filter((row) => row.key.startsWith(prefix))
      const keys = new Set([...known.map((row) => row.key), ...counts.keys()])
      const result: StateRecord[] = []
      for (const key of keys) {
        const [row] = await tx.read([key])
        const prior = known.find((candidate) => candidate.key === key)
        if (row?.version !== prior?.version) throw new StateConflict()
        const group = counts.get(key)
        const old = row && object(row.payload) ? row.payload : undefined
        if (!group && row) {
          try {
            decodeDemand(row)
          } catch {
            await tx.write([{ key, expected: row.version }])
            continue
          }
        }
        const sample = group?.jobs[0]
        const payload: LabelDemand = {
          ...target,
          labels: group?.labels ?? (old!.labels as string[]),
          queued: group?.jobs.length ?? 0,
          dirty: false,
          updatedAt: Date.now(),
          job: sample ? { id: sample.job, runId: sample.run } : (old!.job as unknown as LabelDemand['job']),
        }
        result.push(...(await tx.write([{ key, expected: row?.version ?? null, payload: payload as unknown as Json }])))
      }
      return result
    },
    lease,
  )
}
