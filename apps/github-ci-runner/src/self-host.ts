/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createPrivateKey } from 'node:crypto'
import {
  CredentialSource,
  AppDeliveryRecovery,
  ExecutionJournal,
  GitHubRequestError,
  ExecutionLease,
  ExecutionScope,
  GitHubAppSource,
  GitHubCredential,
  GitHubExecutionBackend,
  InstallationCatalog,
  InstallationDirectory,
  DirectoryBinding,
  DiscoveryRequest,
  DiscoverySnapshot,
  ListenerBackend,
  ListenerCredentials,
  ListenerHost,
  ListenerInbox,
  ListenerState,
  StateDatabase,
  VerifiedWebhook,
  WorkerEvent,
  decodeRepository,
  decodeScope,
} from '@boxlite-ai/ci-listener'
import { BoxLiteWorkers } from './boxlite-workers'
import { privateFile, SelfConfig } from './config'
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
class InstallationPending extends Error {}
export class SelfHost implements ListenerHost {
  readonly recovery?: AppDeliveryRecovery
  private readonly app?: GitHubAppSource
  private readonly pending = new Map<number, ListenerCredentials>()
  private readonly directory?: InstallationDirectory
  discoveryReady = false
  constructor(
    private readonly config: SelfConfig,
    private readonly state: ListenerState,
    private readonly database: StateDatabase,
    private readonly namespace: string,
    private readonly boxes: BoxLiteWorkers,
  ) {
    const auth = config.github
    if (auth.kind === 'app') {
      this.app = new GitHubAppSource({
        issuer: auth.issuer,
        privateKey: () => createPrivateKey(privateFile(auth.privateKeyFile)),
      })
      this.directory = new InstallationDirectory({
        index: (lease, signal) => this.index(lease, signal),
        load: (binding, lease, signal) => this.catalog(binding, lease, signal),
        report: (error, operation) => this.report(error, operation),
      })
      if (config.webhookSecretFile)
        this.recovery = new AppDeliveryRecovery({
          state,
          app: () => this.app!,
          authorize: (lease, installation, signal) => this.replayAuthority(lease, installation, signal),
          report: (error, operation) => this.report(error, operation),
        })
    }
  }
  private async replayAuthority(
    lease: ExecutionLease,
    installation: number | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted()
    await new ExecutionJournal(this.state).load(lease)
    const [root] = await this.state.read(['backend/github'])
    if (
      !root ||
      !object(root.payload) ||
      root.payload.kind !== 'app' ||
      this.config.github.kind !== 'app' ||
      root.payload.issuer !== this.config.github.issuer
    )
      throw new Error('Original GitHub App identity unavailable')
    if (installation !== undefined) {
      try {
        if ((await this.app!.installation(installation, signal)).suspended) return false
      } catch (error) {
        if (error instanceof GitHubRequestError && error.status === 404) return false
        throw error
      }
      await this.replayAuthority(lease, undefined, signal)
    }
    return true
  }
  async discover(lease: ExecutionLease, signal: AbortSignal, request: DiscoveryRequest): Promise<DiscoverySnapshot> {
    if (this.directory) {
      const result = this.directory.step(lease, request, signal)
      this.discoveryReady = result.ready
      return result
    }
    const scopes: ExecutionScope[] = []
    const auth = this.config.github
    if (auth.kind !== 'pat') throw new Error('Missing GitHub source')
    const credential = GitHubCredential.personal(auth.token())
    try {
      const raw = await credential.request(`/repos/${auth.owner}/${auth.repository}`, { signal }),
        repository = decodeRepository(raw)
      if (
        repository.owner.login.toLowerCase() !== auth.owner.toLowerCase() ||
        repository.name.toLowerCase() !== auth.repository.toLowerCase() ||
        !object(raw) ||
        !object(raw.owner) ||
        !['User', 'Organization'].includes(raw.owner.type as string) ||
        (!repository.private && !this.config.allowPublic)
      )
        throw new Error('Configured token repository authority changed')
      scopes.push(
        decodeScope({
          ...this.owner(),
          binding: 'personal-token',
          generation: 1,
          installation: { id: 0, account: { ...repository.owner, type: raw.owner.type } },
          runners: { kind: 'repository', repository, allowPublic: this.config.allowPublic },
        }),
      )
    } finally {
      await credential.close()
    }
    this.discoveryReady = true
    return { scopes, completed: [], ready: true, pending: false }
  }
  private async index(lease: ExecutionLease, signal: AbortSignal): Promise<DirectoryBinding[]> {
    const installations = (await this.app!.installations(signal)).filter((installation) => !installation.suspended)
    if (installations.length > 10000) throw new Error('Installation directory capacity exceeded')
    const [root, prior] = await this.state.read(['backend/github', 'binding/self/current'])
    if (
      !root ||
      !object(root.payload) ||
      this.config.github.kind !== 'app' ||
      root.payload.issuer !== this.config.github.issuer
    )
      throw new Error('Original GitHub App identity unavailable')
    const accounts = Object.fromEntries(
      installations.map((installation) => [String(installation.id), installation.account.id]),
    )
    signal.throwIfAborted()
    // One complete installation/account snapshot; repository hints grant no execution capability.
    await this.state.commit(lease, [
      { key: 'binding/self/current', expected: prior?.version ?? null, payload: { accounts } },
    ])
    return installations.map((installation) => ({
      ...this.owner(),
      installation,
      binding: 'installation:' + installation.id,
      generation: 1,
      policy: { allowPublic: this.config.allowPublic, group: this.config.group },
    }))
  }
  private async catalog(
    binding: DirectoryBinding,
    lease: ExecutionLease,
    signal: AbortSignal,
  ): Promise<ExecutionScope[]> {
    const id = binding.installation.id,
      previous = this.pending.get(id)
    if (previous) {
      await previous.close()
      this.pending.delete(id)
    }
    const provider = new ListenerCredentials(this.state, lease, 'catalog/' + id, {
      kind: 'app',
      app: this.app!,
      installation: binding.installation,
    })
    this.pending.set(id, provider)
    try {
      return await new InstallationCatalog(provider, binding, binding.policy).load(signal)
    } finally {
      await provider.close()
      this.pending.delete(id)
    }
  }
  private owner() {
    return { organization: this.boxes.http.principal.path_prefix, actor: this.boxes.http.principal.sub }
  }
  private async admit(scope: ExecutionScope, signal?: AbortSignal): Promise<void> {
    const source = this.app
    if (source) {
      const actual = await source.installation(scope.installation.id, signal),
        expected = scope.installation.account
      const permission = scope.runners.kind === 'organization' ? 'organization_self_hosted_runners' : 'administration'
      if (
        actual.suspended ||
        actual.account.id !== expected.id ||
        actual.account.login.toLowerCase() !== expected.login ||
        actual.account.type !== expected.type ||
        actual.permissions[permission] !== 'write' ||
        !['read', 'write'].includes(actual.permissions.actions)
      )
        throw new Error('GitHub admission revoked')
    } else {
      const auth = this.config.github
      if (auth.kind !== 'pat' || scope.runners.kind !== 'repository')
        throw new Error('Original token repository required')
      const credential = GitHubCredential.personal(auth.token())
      try {
        const actual = decodeRepository(
            await credential.request(`/repositories/${scope.runners.repository.id}`, { signal }),
          ),
          expected = scope.runners.repository
        if (
          actual.id !== expected.id ||
          actual.owner.id !== expected.owner.id ||
          actual.name.toLowerCase() !== expected.name ||
          actual.private !== expected.private
        )
          throw new Error('Original token repository changed')
      } finally {
        await credential.close()
      }
    }
  }
  async backend(scope: ExecutionScope, lease: ExecutionLease): Promise<ListenerBackend> {
    scope = decodeScope(scope)
    const auth = this.config.github,
      source: CredentialSource = this.app
        ? { kind: 'app', app: this.app, installation: { ...scope.installation, permissions: {}, suspended: false } }
        : auth.kind === 'pat' && scope.runners.kind === 'repository'
          ? { kind: 'pat', repository: scope.runners.repository.id, token: auth.token }
          : (() => {
              throw new Error('Original GitHub source unavailable')
            })()
    const workers = this.boxes.bind(scope, lease, () => this.admit(scope))
    return new GitHubExecutionBackend(
      this.state,
      lease,
      scope,
      source,
      {
        workers,
        authorize: async (original, operation, signal) => {
          if (operation === 'admission') await this.admit(original, signal)
        },
      },
      this.config.worker.labels,
    )
  }
  async accept(notification: VerifiedWebhook): Promise<'stored' | 'duplicate'> {
    if (!this.app) throw new Error('Webhook requires an App source')
    const captured = {
        ...notification,
        hint: { ...notification.hint, job: notification.hint.job ? { ...notification.hint.job } : null },
      },
      hint = captured.hint
    const issuer = this.config.github.kind === 'app' ? this.config.github.issuer : ''
    const ingress = (requireBinding: boolean): StateDatabase => ({
      transaction: (namespace, work, mode) =>
        this.database.transaction(
          namespace,
          async (tx) => {
            if (namespace !== this.namespace) throw new Error('Original Listener namespace changed')
            const [root, current] = await Promise.all([tx.get('backend/github'), tx.get('binding/self/current', true)])
            if (!root || root.schema !== 1 || !object(root.payload) || root.payload.issuer !== issuer)
              throw new Error('Original GitHub App identity unavailable')
            const accounts =
              current && current.schema === 1 && object(current.payload) && object(current.payload.accounts)
                ? current.payload.accounts
                : undefined
            const bound = accounts?.[String(hint.installationId)]
            if (bound !== undefined && bound !== hint.accountId)
              throw new Error('Original installation account changed')
            if (requireBinding && hint.repositoryId !== 0 && bound === undefined)
              throw new InstallationPending('Installation discovery is pending')
            return work(tx)
          },
          mode,
        ),
    })
    try {
      return await new ListenerInbox(new ListenerState(ingress(true), this.namespace)).receive(captured)
    } catch (error) {
      if (error instanceof InstallationPending)
        await new ListenerInbox(new ListenerState(ingress(false), this.namespace)).inventory(hint)
      throw error
    }
  }

  report(error: unknown, operation: string): void {
    if (['listener-cycle', 'listener-session'].includes(operation)) this.discoveryReady = false
    console.error(
      JSON.stringify({
        event: 'ci-listener-deferred',
        operation,
        error: error instanceof Error ? error.constructor.name : 'Unknown',
      }),
    )
  }
  observe(event: WorkerEvent): void {
    console.error(JSON.stringify(event))
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled([this.recovery?.close(), this.directory?.close()])
    const errors: unknown[] = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    for (const [id, provider] of this.pending)
      try {
        await provider.close()
        this.pending.delete(id)
      } catch (error) {
        errors.push(error)
      }
    if (errors.length) throw new AggregateError(errors, 'GitHub catalog retirement is incomplete')
  }
}
