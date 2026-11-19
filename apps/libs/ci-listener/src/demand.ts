/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHash, randomUUID } from 'node:crypto'
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
  expiresAt?: number
  installationId: number
  accountId: number
  repositoryId: number
  labels: string[]
  queued: number
  dirty: boolean
  updatedAt: number
  job: { id: number; runId: number }
  membership?: { generation: string; jobs: number[] }
}
const rank = { queued: 0, in_progress: 1, completed: 2 }
export class DemandUncertain extends Error {
  constructor(
    message?: string,
    readonly requiresJobRefresh = false,
  ) {
    super(message)
  }
}
export class DemandIdentityConflict extends Error {}
const labelsFor = (labels: readonly string[]) => [...new Set(labels.map((label) => label.toLowerCase()))].sort()
function readMembership(value: unknown): LabelDemand['membership'] {
  if (
    !object(value) ||
    typeof value.generation !== 'string' ||
    !value.generation ||
    !Array.isArray(value.jobs) ||
    !value.jobs.every(positive)
  )
    return undefined
  return { generation: value.generation, jobs: value.jobs }
}
function jobCounts(jobs: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const job of jobs) counts.set(job, (counts.get(job) ?? 0) + 1)
  return counts
}
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
    !Number.isSafeInteger(value.installationId) ||
    (value.installationId as number) < 0 ||
    !positive(value.accountId) ||
    !positive(value.repositoryId) ||
    !Array.isArray(value.labels) ||
    !value.labels.length ||
    value.labels.length > 100 ||
    !value.labels.every((label) => typeof label === 'string' && label.length > 0 && label.length <= 128) ||
    !Number.isSafeInteger(value.queued) ||
    (value.queued as number) < 0 ||
    typeof value.dirty !== 'boolean' ||
    (value.membership !== undefined && !readMembership(value.membership)) ||
    !Number.isSafeInteger(value.updatedAt) ||
    !object(value.job) ||
    !positive(value.job.id) ||
    !positive(value.job.runId) ||
    row.key !== demandKey(value.installationId as number, value.repositoryId, value.labels as string[])
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

type RepositoryDemand = Pick<LabelDemand, 'installationId' | 'accountId' | 'repositoryId'>
const revisionKey = (target: RepositoryDemand) => `queue-revision/${target.installationId}/${target.repositoryId}`
async function readRevision(tx: IngressTransaction, target: RepositoryDemand): Promise<StateRecord | undefined> {
  const [row] = await tx.read([revisionKey(target)])
  if (
    row &&
    (row.schema !== 1 ||
      !object(row.payload) ||
      row.payload.installationId !== target.installationId ||
      row.payload.accountId !== target.accountId ||
      row.payload.repositoryId !== target.repositoryId)
  )
    throw new StateCorrupt()
  return row
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
  const revision = await readRevision(tx, hint)
  const fact = { ...observation, hint } as typeof observation & { hint: WakeHint; countedFor?: string }
  const changes: StateChange[] = [
    {
      key: revisionKey(hint),
      expected: revision?.version ?? null,
      payload: {
        installationId: hint.installationId,
        accountId: hint.accountId,
        repositoryId: hint.repositoryId,
      },
    },
    {
      key: factKey,
      expected: prior?.version ?? null,
      payload: fact as unknown as Json,
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
    const membership = old?.membership ?? { generation: randomUUID(), jobs: [] }
    if (delta > 0) fact.countedFor = membership.generation
    let change = delta
    if (delta < 0 && old?.membership) {
      const scanned = membership.jobs.reduce((sum, id) => sum + Number(id === jobId), 0)
      const incremented = prior && object(prior.payload) && prior.payload.countedFor === membership.generation
      change = -(scanned || Number(!!incremented))
      if (!change) continue
    }
    // A historical aggregate carries no evidence that a queued fact survived its last full scan.
    const uncertain = !!old && !old.membership
    const queued = (old?.queued ?? 0) + (uncertain && change < 0 ? 0 : change)
    const value: LabelDemand = {
      installationId: hint.installationId,
      accountId: hint.accountId,
      repositoryId: hint.repositoryId,
      labels,
      queued: Math.max(0, queued),
      dirty: (old?.dirty ?? false) || uncertain || queued < 0,
      updatedAt: Date.now(),
      job: { ...hint.job },
      membership,
    }
    changes.push({ key, expected: row?.version ?? null, payload: value as unknown as Json })
  }
  return changes
}

/** Replace a suspect count only if no webhook arrived during its authoritative scan. */
export async function rebuildQueueSnapshot(
  state: ListenerState,
  lease: ExecutionLease,
  target: Pick<LabelDemand, 'installationId' | 'accountId' | 'repositoryId'>,
  previous: readonly StateRecord[],
  jobs: readonly WorkflowJob[],
  wakeVersion?: string,
  expectedRevision?: { version: string | undefined },
  signal?: AbortSignal,
): Promise<{ demands: StateRecord[]; revision: StateRecord }> {
  const prefix = `demand/${target.installationId}/${target.repositoryId}/`
  const wakeKey = `wake/${target.installationId}/${target.repositoryId}`
  return state.ingress(
    `${target.installationId}/${target.repositoryId}`,
    async (tx) => {
      const [wake] = await tx.read([wakeKey])
      if (wake?.version !== wakeVersion) throw new StateConflict()
      const revision = await readRevision(tx, target)
      if (expectedRevision && revision?.version !== expectedRevision.version) throw new StateConflict()
      let changed = !revision
      const counts = new Map<string, { labels: string[]; jobs: WorkflowJob[] }>()
      const incremental = new Map<number, string>()
      const queued = jobs.filter(
        (job) => job.repository === target.repositoryId && job.status === 'queued' && job.runner === null,
      )
      const factKey = (job: WorkflowJob) => `job-fact/${target.installationId}/${job.job}`
      for (let offset = 0; offset < queued.length; offset += 100) {
        const batch = queued.slice(offset, offset + 100)
        const facts = new Map((await tx.read(batch.map(factKey))).map((row) => [row.key, row]))
        const missing = new Map<string, StateChange>()
        for (const job of batch) {
          const key = factKey(job)
          const fact = facts.get(key)
          if (fact && object(fact.payload) && ['in_progress', 'completed'].includes(fact.payload.status as string))
            continue
          if (fact && object(fact.payload) && typeof fact.payload.countedFor === 'string')
            incremental.set(job.job, fact.payload.countedFor)
          if (!fact && !missing.has(key))
            missing.set(key, {
              key,
              expected: null,
              payload: {
                status: 'queued',
                labels: labelsFor(job.labels),
                runner: null,
                hint: { ...target, job: { id: job.job, runId: job.run } },
              },
            })
          const groupKey = demandKey(target.installationId, target.repositoryId, job.labels)
          const entry = counts.get(groupKey) ?? { labels: labelsFor(job.labels), jobs: [] }
          entry.jobs.push(job)
          counts.set(groupKey, entry)
        }
        if (missing.size) {
          await tx.write([...missing.values()])
          changed = true
        }
      }
      const known = previous.filter((row) => row.key.startsWith(prefix))
      const priorCounts = new Map(known.map((row) => [row.key, row]))
      const keys = [...new Set([...priorCounts.keys(), ...counts.keys()])]
      const result: StateRecord[] = []
      for (let offset = 0; offset < keys.length; offset += 100) {
        const batch = keys.slice(offset, offset + 100)
        const current = new Map((await tx.read(batch)).map((row) => [row.key, row]))
        for (const key of batch) {
          const row = current.get(key)
          const prior = priorCounts.get(key)
          if (row?.version !== prior?.version) throw new StateConflict()
          const group = counts.get(key)
          const old = row && object(row.payload) ? row.payload : undefined
          if (!group && row) {
            try {
              decodeDemand(row)
            } catch {
              await tx.write([{ key, expected: row.version }])
              changed = true
              continue
            }
          }
          const sample = group?.jobs[0]
          const ids = group?.jobs.map((job) => job.job) ?? []
          const previousMembership = readMembership(old?.membership)
          const members = jobCounts(previousMembership?.jobs ?? [])
          const sameMembers =
            previousMembership &&
            old?.dirty === false &&
            old.queued === ids.length &&
            [...jobCounts(ids)].every(
              ([id, count]) =>
                count === (members.get(id) ?? Number(incremental.get(id) === previousMembership.generation)),
            )
          const payload: LabelDemand = {
            ...target,
            labels: group?.labels ?? (old!.labels as string[]),
            queued: group?.jobs.length ?? 0,
            dirty: false,
            updatedAt: Date.now(),
            job: sample ? { id: sample.job, runId: sample.run } : (old!.job as unknown as LabelDemand['job']),
            membership: sameMembers ? previousMembership : { generation: randomUUID(), jobs: ids },
          }
          if (
            row &&
            old &&
            sameMembers &&
            old.installationId === target.installationId &&
            old.accountId === target.accountId &&
            old.repositoryId === target.repositoryId &&
            JSON.stringify(old.labels) === JSON.stringify(payload.labels) &&
            object(old.job) &&
            old.job.id === payload.job.id &&
            old.job.runId === payload.job.runId
          )
            result.push(row)
          else {
            changed = true
            result.push(
              ...(await tx.write([{ key, expected: row?.version ?? null, payload: payload as unknown as Json }])),
            )
          }
        }
      }
      const committed = changed
        ? (
            await tx.write([{ key: revisionKey(target), expected: revision?.version ?? null, payload: { ...target } }])
          )[0]
        : revision!
      return { demands: result, revision: committed }
    },
    lease,
    signal,
  )
}

/** Counter-only compatibility entry point; snapshots also maintain the repository fence. */
export async function rebuildDemand(...args: Parameters<typeof rebuildQueueSnapshot>): Promise<StateRecord[]> {
  return (await rebuildQueueSnapshot(...args)).demands
}
