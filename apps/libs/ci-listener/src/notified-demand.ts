/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { demandKey, LabelDemand, observeDemand } from './demand'
import { ExecutionScope, object } from './execution/model'
import { JobNotice, WorkflowJob, jobMatches } from './jobs'
import { StateConflict } from './state/database'
import { ExecutionLease, ListenerState } from './state/store'
import { repositories } from './scheduling'

interface VerifiedJob {
  job: WorkflowJob
  version: string
  expiresAt: number
}
/** Bounded positive evidence accumulates across turns; facts invalidate cancelled or claimed jobs. */
export class NotifiedDemand {
  private readonly merging = new Map<string, Promise<void>>()
  private readonly generations = new Map<string, { epoch: number; readers: number }>()
  private readonly jobs = new Map<string, Map<number, VerifiedJob>>()
  constructor(
    private readonly state: ListenerState,
    private readonly lease: ExecutionLease,
    private readonly labels: readonly string[],
  ) {}

  async read(
    scope: ExecutionScope,
    notices: readonly JobNotice[],
    read: (notices: readonly JobNotice[]) => Promise<WorkflowJob[]>,
  ): Promise<LabelDemand[]> {
    const result: LabelDemand[] = []
    const allowed = repositories(scope),
      prefix = `${scope.installation.id}/`
    const targets = new Set(
      notices.length
        ? notices.map((notice) => notice.repository)
        : [...this.jobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => Number(key.slice(prefix.length))),
    )
    for (const repository of targets) {
      if (!allowed.includes(repository)) continue
      const target = {
        installationId: scope.installation.id,
        accountId: scope.installation.account.id,
        repositoryId: repository,
      }
      const key = `${target.installationId}/${repository}`,
        revisionKey = `queue-revision/${key}`,
        wakeKey = `wake/${key}`
      const selected = notices.filter((notice) => notice.repository === repository)
      const generation = this.generations.get(key) ?? { epoch: 0, readers: 0 }
      const epoch = generation.epoch
      generation.readers++
      this.generations.set(key, generation)
      try {
        const before = new Map(
          (await this.state.read([revisionKey, wakeKey], this.lease)).map((row) => [row.key, row.version]),
        )
        const observedAt = selected.length ? await this.state.now(this.lease) : 0
        const observations = selected.length ? await read(selected) : []
        const expected = new Map(selected.map((notice) => [notice.job, notice]))
        if (
          observations.length !== expected.size ||
          new Set(observations.map((job) => job.job)).size !== expected.size ||
          observations.some((job) => job.repository !== repository || job.run !== expected.get(job.job)?.run)
        )
          throw new Error('Notified GitHub job identity changed')
        await this.serialize(key, async () => {
          if (generation.epoch !== epoch) throw new StateConflict()
          const next = new Map(this.jobs.get(key))
          const now = await this.state.now(this.lease)
          for (const [id, entry] of next) if (entry.expiresAt <= now) next.delete(id)
          const committed = await this.state
            .ingress(
              key,
              async (tx) => {
                const rows = new Map((await tx.read([revisionKey, wakeKey])).map((row) => [row.key, row]))
                if (
                  rows.get(revisionKey)?.version !== before.get(revisionKey) ||
                  rows.get(wakeKey)?.version !== before.get(wakeKey)
                )
                  throw new StateConflict()
                for (const job of observations) {
                  if (job.status === 'queued' || job.status === 'in_progress' || job.status === 'completed') {
                    const changes = await observeDemand(
                      tx,
                      { ...target, job: { id: job.job, runId: job.run } },
                      { ...job, status: job.status },
                    )
                    if (changes.length) await tx.write(changes)
                  }
                  const [fact] = await tx.read([`job-fact/${target.installationId}/${job.job}`])
                  if (
                    fact &&
                    object(fact.payload) &&
                    fact.payload.status === 'queued' &&
                    jobMatches(job, this.labels) &&
                    observedAt + 30000 > now
                  )
                    next.set(job.job, { job, version: fact.version, expiresAt: observedAt + 30000 })
                  else next.delete(job.job)
                }
                // Revalidate every accumulated fact in the same repository transaction.
                // A later observation changes the queue revision checked by reservation and create intent.
                const facts = new Map(
                  (next.size
                    ? await tx.read([...next.keys()].map((id) => `job-fact/${target.installationId}/${id}`))
                    : []
                  ).map((row) => [row.key, row]),
                )
                for (const [id, entry] of next) {
                  const fact = facts.get(`job-fact/${target.installationId}/${id}`)
                  if (fact?.version !== entry.version || !object(fact.payload) || fact.payload.status !== 'queued')
                    next.delete(id)
                }
                while (next.size > 4096) next.delete(next.keys().next().value!)
                const [revision] = await tx.read([revisionKey])
                const groups = new Map<string, LabelDemand>()
                for (const { job, expiresAt } of next.values()) {
                  const groupKey = demandKey(target.installationId, repository, job.labels)
                  const group = groups.get(groupKey)
                  groups.set(groupKey, {
                    ...target,
                    key: revision!.key,
                    version: revision!.version,
                    labels: [...job.labels],
                    queued: (group?.queued ?? 0) + 1,
                    dirty: false,
                    updatedAt: now,
                    expiresAt: Math.min(group?.expiresAt ?? expiresAt, expiresAt),
                    job: { id: job.job, runId: job.run },
                  })
                }
                return [...groups.values()]
              },
              this.lease,
            )
            .catch((error) => {
              if (error instanceof StateConflict && !selected.length) return undefined
              throw error
            })
          if (!committed) return
          if (next.size) this.jobs.set(key, next)
          else this.jobs.delete(key)
          let excess = [...this.jobs.values()].reduce((count, jobs) => count + jobs.size, 0) - 4096
          for (const [repository, jobs] of this.jobs) {
            while (excess > 0 && jobs.size) {
              jobs.delete(jobs.keys().next().value!)
              excess--
            }
            if (!jobs.size) this.jobs.delete(repository)
            if (excess <= 0) break
          }
          result.push(...committed)
        })
      } finally {
        if (--generation.readers === 0) this.generations.delete(key)
      }
    }
    return result
  }
  async invalidate(installation: number, repository: number): Promise<void> {
    const key = `${installation}/${repository}`
    await this.serialize(key, async () => {
      const generation = this.generations.get(key)
      if (generation) generation.epoch++
      this.jobs.delete(key)
    })
  }
  private async serialize(key: string, work: () => Promise<void>): Promise<void> {
    const previous = this.merging.get(key)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    this.merging.set(key, held)
    await previous
    try {
      await work()
    } finally {
      release()
      if (this.merging.get(key) === held) this.merging.delete(key)
    }
  }
}
