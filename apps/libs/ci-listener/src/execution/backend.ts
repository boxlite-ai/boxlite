/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { CredentialSource, ListenerCredentials } from '../credentials'
import { decodeRepository, GitHubJobs, GitHubRepository, JobNotice, WorkflowJob } from '../jobs'
import { GitHubRunners, RunnerEffect } from '../runners'
import { ExecutionLease, ListenerState } from '../state/store'
import { WorkerExecutor } from '../worker'
import { ExecutionJournal } from './journal'
import { decodeScope, ExecutionScope, scopeKey } from './model'
import { PoolBackend, RunnerSession } from './pool'

export interface ExecutionHost {
  workers: WorkerExecutor
  /** A host may fence an undispatched create with its original-ID ledger. */
  rejectUndispatchedCreate?(name: string, effect: string): Promise<never>
  /** Cleanup may retain original-resource authority after admission is revoked. */
  authorize(scope: ExecutionScope, operation: 'admission' | 'cleanup', signal?: AbortSignal): Promise<void>
}

/** Binds live host authority, one original scope and scoped GitHub credentials. */
export class GitHubExecutionBackend implements PoolBackend {
  readonly workers: WorkerExecutor
  private readonly scope: ExecutionScope
  private readonly lease: ExecutionLease
  private readonly credentials: ListenerCredentials
  private readonly journal: ExecutionJournal
  private readonly labels: string[]
  constructor(
    state: ListenerState,
    lease: ExecutionLease,
    scope: ExecutionScope,
    source: CredentialSource,
    private readonly host: ExecutionHost,
    labels: readonly string[],
  ) {
    this.scope = decodeScope(scope)
    this.lease = { ...lease }
    this.labels = [...labels]
    this.journal = new ExecutionJournal(state)
    const original = this.scope.installation
    if (source.kind === 'app') {
      if (
        source.installation.id !== original.id ||
        source.installation.account.id !== original.account.id ||
        source.installation.account.type !== original.account.type ||
        source.installation.account.login.toLowerCase() !== original.account.login
      )
        throw new Error('GitHub credentials do not belong to the original execution scope')
    } else if (
      original.id !== 0 ||
      this.scope.runners.kind !== 'repository' ||
      source.repository !== this.scope.runners.repository.id
    )
      throw new Error('Personal token does not belong to the original execution scope')
    this.credentials = new ListenerCredentials(state, this.lease, scopeKey(this.scope), source)
    this.workers = {
      create: async (launch) => {
        const originalLaunch = { ...launch, entrypoint: [...launch.entrypoint] }
        let effect: string | undefined
        if (host.rejectUndispatchedCreate) {
          const snapshot = await this.journal.load(this.lease)
          const row = [...snapshot.allocations.values()].find((item) => item.value.name === originalLaunch.name)
          if (
            !row ||
            row.value.scope !== scopeKey(this.scope) ||
            row.value.box.phase !== 'requested' ||
            row.value.effect?.kind !== 'box-create'
          )
            throw new Error('Original creation intent required')
          effect = row.value.effect.id
        }
        try {
          await this.check('admission')
        } catch (error) {
          if (effect) await host.rejectUndispatchedCreate!(originalLaunch.name, effect)
          throw error
        }
        return host.workers.create(originalLaunch)
      },
      get: async (name) => {
        await this.check('cleanup')
        return host.workers.get(name)
      },
      stop: async (name) => {
        await this.check('cleanup')
        return host.workers.stop(name)
      },
      remove: async (name) => {
        await this.check('cleanup')
        return host.workers.remove(name)
      },
      deliverJit: async (name, configuration, signal) => {
        await this.check('admission', signal)
        return host.workers.deliverJit(name, configuration, signal)
      },
    }
  }
  private async check(operation: 'admission' | 'cleanup', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.host.authorize(decodeScope(this.scope), operation, signal)
    // Recheck the lease and allocation graph after the asynchronous host check.
    await this.journal.load(this.lease)
    signal?.throwIfAborted()
  }
  admit(signal?: AbortSignal): Promise<void> {
    return this.check('admission', signal)
  }
  private contains(repository: number): boolean {
    return this.scope.runners.kind === 'repository'
      ? repository === this.scope.runners.repository.id
      : this.scope.runners.repositories.includes(repository)
  }
  async job(notice: JobNotice, signal?: AbortSignal): Promise<WorkflowJob> {
    notice = { ...notice }
    return this.readJobs(notice.repository, (jobs) => jobs.job(notice, signal), signal)
  }
  queued(repository: number, signal?: AbortSignal): Promise<WorkflowJob[]> {
    return this.readJobs(repository, (jobs) => jobs.queued(signal), signal)
  }
  private async readJobs<T>(
    repositoryId: number,
    read: (jobs: GitHubJobs) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.contains(repositoryId)) throw new Error('Job is outside the original execution scope')
    await this.check('admission', signal)
    const borrow = await this.credentials.open({ kind: 'jobs', repository: repositoryId }, signal)
    try {
      let repository: GitHubRepository
      if (this.scope.runners.kind === 'repository') repository = this.scope.runners.repository
      else {
        repository = decodeRepository(await borrow.credential.request(`/repositories/${repositoryId}`, { signal }))
        const account = this.scope.installation.account
        if (
          repository.id !== repositoryId ||
          repository.owner.id !== account.id ||
          repository.owner.login.toLowerCase() !== account.login
        )
          throw new Error('GitHub job repository authority changed')
      }
      if (!repository.private && !this.scope.runners.allowPublic)
        throw new Error('Public repository runners are disabled')
      const result = await read(new GitHubJobs(borrow.credential, repository))
      await this.check('admission', signal)
      return result
    } finally {
      await borrow.close()
    }
  }
  async runners(beforeMutation: (effect: RunnerEffect) => Promise<void>, signal?: AbortSignal): Promise<RunnerSession> {
    await this.check('cleanup', signal)
    const purpose =
      this.scope.runners.kind === 'repository'
        ? { kind: 'repository-runners' as const, repository: this.scope.runners.repository.id }
        : { kind: 'organization-runners' as const }
    const borrow = await this.credentials.open(purpose, signal)
    try {
      const registry = new GitHubRunners(borrow.credential, this.scope.runners, this.labels, async (effect) => {
        await this.check(effect.kind === 'register' ? 'admission' : 'cleanup', signal)
        await beforeMutation({ ...effect })
        await this.journal.load(this.lease)
      })
      return { registry, close: () => borrow.close() }
    } catch (error) {
      await borrow.close()
      throw error
    }
  }
  close(): Promise<void> {
    return this.credentials.close()
  }
}
