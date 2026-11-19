/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ActionsScaleSets } from '../scale-set-client'
import { CredentialSource, ListenerCredentials } from '../credentials'
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
  private readonly workerCredentials = new Map<string, ListenerCredentials>()
  private readonly journal: ExecutionJournal
  private readonly labels: string[]
  private closed = false
  readonly scaleSets: ActionsScaleSets
  private readonly setRegistration: ListenerCredentials
  private readonly setAuthority: ListenerCredentials
  private groupRead?: Promise<ReadonlySet<string>>
  constructor(
    private readonly state: ListenerState,
    lease: ExecutionLease,
    scope: ExecutionScope,
    private readonly source: CredentialSource,
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
    this.setRegistration = this.credentials.fork(scopeKey(this.scope) + '/scale-set-registration')
    this.setAuthority = this.credentials.fork(scopeKey(this.scope) + '/scale-set-authority')
    const runners = this.scope.runners
    const route =
      runners.kind === 'organization'
        ? '/orgs/' + runners.account.login
        : '/repos/' + runners.repository.owner.login + '/' + runners.repository.name
    const configUrl = 'https://github.com/' + route.slice(route.indexOf('/', 1) + 1)
    this.scaleSets = new ActionsScaleSets(configUrl, async (signal) => {
      const purpose =
        runners.kind === 'organization'
          ? { kind: 'organization-runners' as const }
          : { kind: 'repository-runners' as const, repository: runners.repository.id }
      const borrow = await this.setRegistration.open(purpose, signal)
      try {
        const result = await borrow.credential.request(route + '/actions/runners/registration-token', {
          method: 'POST',
          signal,
        })
        if (!result || typeof result !== 'object' || !('token' in result) || typeof result.token !== 'string')
          throw new Error('Invalid runner registration token')
        return result.token
      } finally {
        await borrow.close()
      }
    })
    this.workers = {
      create: async (launch) => {
        const originalLaunch = { ...launch, entrypoint: [...launch.entrypoint] }
        let effect: string | undefined
        if (host.rejectUndispatchedCreate) {
          if (!/^ci-jit-[a-f0-9]{32}$/.test(originalLaunch.name)) throw new Error('Original CI worker required')
          const row = await this.journal.allocation(this.lease, 'worker/' + originalLaunch.name.slice(7))
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
          await this.repositoryPolicy(originalLaunch.name)
        } catch (error) {
          if (effect) await host.rejectUndispatchedCreate!(originalLaunch.name, effect)
          throw error
        }
        this.assertOpen()
        return host.workers.create(originalLaunch)
      },
      get: async (name) => {
        await this.check('cleanup')
        this.assertOpen()
        return host.workers.get(name)
      },
      stop: async (name) => {
        await this.check('cleanup')
        this.assertOpen()
        return host.workers.stop(name)
      },
      remove: async (name) => {
        await this.check('cleanup')
        this.assertOpen()
        return host.workers.remove(name)
      },
      deliverJit: async (name, configuration, signal) => {
        await this.check('admission', signal)
        await this.repositoryPolicy(name, signal)
        this.assertOpen()
        return host.workers.deliverJit(name, configuration, signal)
      },
      recoverJit:
        host.workers.recoverJit &&
        (async (name, effect, signal) => {
          await this.check('admission', signal)
          await this.repositoryPolicy(name, signal)
          this.assertOpen()
          return host.workers.recoverJit!(name, effect, signal)
        }),
    }
  }
  private async repositoryPolicy(name: string, signal?: AbortSignal): Promise<void> {
    const row = await this.journal.allocation(this.lease, 'worker/' + name.slice(7))
    if (row?.value.scope !== scopeKey(this.scope) || !row.value.supply?.scaleSet)
      throw new Error('Original scale set required')
    await this.scaleSetAuthority(signal)
  }
  async scaleSetAuthority(signal?: AbortSignal): Promise<ReadonlySet<string>> {
    await this.check('admission', signal)
    if (this.groupRead) return this.groupRead
    const runners = this.scope.runners
    const purpose =
      runners.kind === 'repository'
        ? { kind: 'repository-runners' as const, repository: runners.repository.id }
        : { kind: 'organization-runners' as const }
    this.groupRead = (async () => {
      const borrow = await this.setAuthority.open(purpose, signal)
      try {
        const registry = new GitHubRunners(borrow.credential, runners, this.labels, async () => {
          throw new Error('Read only')
        })
        return await registry.authority(true, signal)
      } finally {
        await borrow.close()
      }
    })().finally(() => {
      this.groupRead = undefined
    })
    return this.groupRead
  }
  private async check(operation: 'admission' | 'cleanup', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.assertOpen()
    await this.host.authorize(decodeScope(this.scope), operation, signal)
    this.assertOpen()
    // Authorization can wait across lease expiry; recheck the original scope afterward.
    await this.journal.scope(this.lease, scopeKey(this.scope))
    this.assertOpen()
    signal?.throwIfAborted()
  }
  admit(signal?: AbortSignal): Promise<void> {
    return this.check('admission', signal)
  }
  async runners(
    beforeMutation: (effect: RunnerEffect) => Promise<void>,
    signal?: AbortSignal,
    labels: readonly string[] = this.labels,
    name?: string,
    scaleSet?: number,
  ): Promise<RunnerSession> {
    labels = [...labels]
    await this.check('cleanup', signal)
    if (!name || !/^ci-jit-[a-f0-9]{32}$/.test(name))
      throw new Error('Original CI worker required for credential isolation')
    const allocation = await this.journal.allocation(this.lease, 'worker/' + name.slice(7))
    if (!scaleSet || allocation?.value.supply?.scaleSet !== scaleSet || allocation.value.scope !== scopeKey(this.scope))
      throw new Error('Original scale set required')
    const guard = async (effect: RunnerEffect) => {
      await this.check(effect.kind === 'register' ? 'admission' : 'cleanup', signal)
      if (effect.kind === 'register') await this.scaleSetAuthority(signal)
      await beforeMutation(effect)
      await this.journal.check(this.lease)
    }
    const owned = this.scaleSets.registry(scaleSet, guard)
    const registry = {
      ...owned,
      retireIdle: async (
        identity: { id: number; name: string },
        readSignal?: AbortSignal,
        checkRetirement?: () => void,
      ) => {
        if (!(await owned.lookup(identity, readSignal))) return false
        const runners = this.scope.runners
        const purpose =
          runners.kind === 'repository'
            ? { kind: 'repository-runners' as const, repository: runners.repository.id }
            : { kind: 'organization-runners' as const }
        const borrow = await this.credentialsFor(name).open(purpose, readSignal)
        try {
          return await new GitHubRunners(borrow.credential, runners, labels, guard).retireKnownIdle(
            identity,
            () => owned.lookup(identity, readSignal),
            readSignal,
            checkRetirement,
          )
        } finally {
          await borrow.close()
        }
      },
    }
    return { registry, close: async () => {} }
  }
  private assertOpen(): void {
    if (this.closed) throw new Error('CI execution backend is closed')
  }
  private credentialsFor(name: string): ListenerCredentials {
    this.assertOpen()
    if (!/^ci-jit-[a-f0-9]{32}$/.test(name)) throw new Error('Original CI worker required for credential isolation')
    let provider = this.workerCredentials.get(name)
    if (!provider) {
      provider = new ListenerCredentials(
        this.state,
        this.lease,
        scopeKey(this.scope) + '/' + name.slice(7),
        this.source,
      )
      this.workerCredentials.set(name, provider)
    }
    return provider
  }
  async retire(name: string): Promise<void> {
    const provider = this.workerCredentials.get(name)
    if (!provider) return
    await provider.close()
    this.workerCredentials.delete(name)
  }
  async close(): Promise<void> {
    this.closed = true
    const results = await Promise.allSettled([
      this.credentials.close(),
      this.setAuthority.close(),
      this.setRegistration.close(),
      ...[...this.workerCredentials.keys()].map((name) => this.retire(name)),
    ])
    const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Runner credential retirement is incomplete')
  }
}
