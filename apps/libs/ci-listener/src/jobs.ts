/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubCredential } from './github-app'
import { selectRunnerLabels } from './resource-labels'

export interface GitHubRepository {
  id: number
  owner: { id: number; login: string }
  name: string
  private: boolean
}
export interface JobNotice {
  repository: number
  run: number
  job: number
}
export interface WorkflowJob extends JobNotice {
  status: 'queued' | 'in_progress' | 'waiting' | 'requested' | 'pending' | 'completed'
  labels: string[]
  runner: number | null
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const account = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value)
const name = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..'

export function decodeRepository(value: unknown): GitHubRepository {
  if (
    !object(value) ||
    !id(value.id) ||
    !object(value.owner) ||
    !id(value.owner.id) ||
    !account(value.owner.login) ||
    !name(value.name) ||
    typeof value.private !== 'boolean'
  )
    throw new Error('Invalid GitHub repository metadata')
  return {
    id: value.id,
    owner: { id: value.owner.id, login: value.owner.login },
    name: value.name,
    private: value.private,
  }
}

/** The credential owner handles refresh and retirement; this reader never issues tokens or acknowledges notices. */
export class GitHubJobs {
  private readonly repository: GitHubRepository
  constructor(
    private readonly credential: GitHubCredential,
    repository: GitHubRepository,
  ) {
    this.repository = decodeRepository(repository)
  }
  private get route(): string {
    return `/repos/${this.repository.owner.login}/${this.repository.name}`
  }
  private async authority(signal?: AbortSignal): Promise<void> {
    const actual = decodeRepository(await this.credential.request(`/repositories/${this.repository.id}`, { signal }))
    const expected = this.repository
    if (
      actual.id !== expected.id ||
      actual.owner.id !== expected.owner.id ||
      actual.owner.login.toLowerCase() !== expected.owner.login.toLowerCase() ||
      actual.name.toLowerCase() !== expected.name.toLowerCase() ||
      actual.private !== expected.private
    )
      throw new Error('GitHub repository authority changed')
  }
  private decode(value: unknown, run: number): WorkflowJob {
    if (
      !object(value) ||
      !id(value.id) ||
      value.run_id !== run ||
      !['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed'].includes(value.status as string) ||
      !Array.isArray(value.labels) ||
      value.labels.length > 100 ||
      !value.labels.every((label) => typeof label === 'string' && label.length > 0 && label.length <= 128) ||
      (value.runner_id !== null && value.runner_id !== 0 && !id(value.runner_id))
    )
      throw new Error('Invalid GitHub workflow job')
    const conclusions = [
      'success',
      'failure',
      'neutral',
      'cancelled',
      'skipped',
      'timed_out',
      'action_required',
      'stale',
      'startup_failure',
    ]
    if (
      value.status === 'completed'
        ? !conclusions.includes(value.conclusion as string) ||
          typeof value.completed_at !== 'string' ||
          !Number.isFinite(Date.parse(value.completed_at))
        : value.conclusion !== null || value.completed_at !== null
    )
      throw new Error('Inconsistent GitHub workflow job completion')
    return {
      repository: this.repository.id,
      run,
      job: value.id,
      status: value.status as WorkflowJob['status'],
      labels: value.labels as string[],
      runner: (value.runner_id || null) as number | null,
    }
  }
  async job(notice: JobNotice, signal?: AbortSignal): Promise<WorkflowJob> {
    notice = { ...notice }
    if (notice.repository !== this.repository.id || !id(notice.run) || !id(notice.job))
      throw new Error('Job notice is outside its original repository')
    await this.authority(signal)
    const job = this.decode(
      await this.credential.request(`${this.route}/actions/jobs/${notice.job}`, { signal }),
      notice.run,
    )
    if (job.job !== notice.job) throw new Error('GitHub workflow job identity changed')
    await this.authority(signal)
    return job
  }
  /** A bounded, complete pass. Any changing count, API cap or permission failure leaves the caller's wake pending. */
  async queued(signal?: AbortSignal): Promise<WorkflowJob[]> {
    await this.authority(signal)
    const runs = new Set<number>(),
      jobs = new Map<number, WorkflowJob>()
    for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
      const batch = await this.list(`${this.route}/actions/runs?status=${status}`, 'workflow_runs', signal, 1000)
      for (const run of batch) {
        if (!object(run) || !id(run.id) || !object(run.repository) || run.repository.id !== this.repository.id)
          throw new Error('Invalid GitHub workflow run')
        runs.add(run.id)
      }
    }
    for (const run of runs) {
      const batch = await this.list(`${this.route}/actions/runs/${run}/jobs?filter=latest`, 'jobs', signal, 100_000)
      for (const raw of batch) {
        const job = this.decode(raw, run)
        if (jobs.has(job.job)) throw new Error('Duplicate GitHub workflow job')
        if (job.status === 'queued') jobs.set(job.job, job)
      }
    }
    await this.authority(signal)
    return [...jobs.values()].sort((a, b) => a.job - b.job)
  }
  private async list(
    route: string,
    field: 'workflow_runs' | 'jobs',
    signal: AbortSignal | undefined,
    maximum: number,
  ): Promise<unknown[]> {
    const result: unknown[] = [],
      seen = new Set<number>()
    let total: number | undefined
    for (let page = 1; page <= 1000; page++) {
      const value = await this.credential.request(`${route}&per_page=100&page=${page}`, { signal })
      if (
        !object(value) ||
        !Number.isSafeInteger(value.total_count) ||
        (value.total_count as number) < 0 ||
        (value.total_count as number) > maximum ||
        (total !== undefined && value.total_count !== total) ||
        !Array.isArray(value[field]) ||
        value[field].length > 100
      )
        throw new Error('Incomplete GitHub task inventory')
      total = value.total_count as number
      for (const item of value[field]) {
        if (!object(item) || !id(item.id) || seen.has(item.id))
          throw new Error('Duplicate or invalid GitHub task inventory')
        seen.add(item.id)
        result.push(item)
      }
      if (result.length > total || (result.length < total && value[field].length < 100))
        throw new Error('Incomplete GitHub task inventory')
      if (result.length === total) return result
    }
    throw new Error('GitHub task inventory exceeds pagination limit')
  }
}

/** JIT registration must supply every requested label; a custom runner name alone is insufficient. */
export function jobMatches(job: WorkflowJob, labels: readonly string[]): boolean {
  return job.status === 'queued' && job.runner === null && selectRunnerLabels(job.labels, labels) !== null
}
