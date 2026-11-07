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
  CiGitHubApp,
  ScopeApplications,
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
  readonly recovery?: Pick<AppDeliveryRecovery, 'step' | 'close'>
  private readonly recoveries: AppDeliveryRecovery[] = []
  readonly applications = new Map<string, CiGitHubApp>()
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
      for (const entry of auth.applications ?? [auth]) {
        const secretFile =
          entry.webhookSecretFile ?? (entry.issuer === auth.issuer ? config.webhookSecretFile : undefined)
        if (this.applications.has(entry.issuer)) throw new Error('Duplicate GitHub App identity')
        this.applications.set(
          entry.issuer,
          new CiGitHubApp({
            clientId: entry.issuer,
            accountType: entry.accountType,
            privateKey: () => createPrivateKey(privateFile(entry.privateKeyFile)),
            webhookSecret: secretFile ? () => Buffer.from(privateFile(secretFile).toString('utf8').trim()) : undefined,
          }),
        )
      }
      this.directory = new InstallationDirectory({
        index: (lease, signal) => this.index(lease, signal),
        load: (binding, lease, signal) => this.catalog(binding, lease, signal),
        report: (error, operation) => this.report(error, operation),
      })
      for (const app of this.applications.values()) {
        const entry = (auth.applications ?? [auth]).find((item) => item.issuer === app.clientId)!
        if (!(entry.webhookSecretFile || (entry.issuer === auth.issuer && config.webhookSecretFile))) continue
        app.secret()
        this.recoveries.push(
          new AppDeliveryRecovery({
            state,
            app: () => app.appSource(),
            prefix: app.clientId === auth.issuer ? 'replay/' : 'replay-' + app.clientId + '/',
            authorize: (lease, installation, signal) => this.replayAuthority(app.clientId, lease, installation, signal),
            report: (error, operation) => this.report(error, operation),
          }),
        )
      }
      if (this.recoveries.length)
        this.recovery = {
          step: (lease, signal) => {
            for (const recovery of this.recoveries) recovery.step(lease, signal)
          },
          close: async () => {
            await Promise.all(this.recoveries.map((recovery) => recovery.close()))
          },
        }
    }
  }
  private scopes(): ScopeApplications {
    if (this.config.github.kind !== 'app') throw new Error('Original App required')
    return new ScopeApplications(this.state, 'backend/github', this.config.github.issuer)
  }

  private async replayAuthority(
    client: string,
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
        if ((await this.applications.get(client)!.appSource().installation(installation, signal)).suspended)
          return false
      } catch (error) {
        if (error instanceof GitHubRequestError && error.status === 404) return false
        throw error
      }
      await this.replayAuthority(client, lease, undefined, signal)
    }
    return true
  }
  private async registerApplications(lease: ExecutionLease): Promise<void> {
    if (this.config.github.kind !== 'app') throw new Error('Original App required')
    const [root] = await this.state.read(['backend/github'])
    const ids = [...this.applications.keys()]
    if (
      !root ||
      root.schema !== 1 ||
      !object(root.payload) ||
      root.payload.kind !== 'app' ||
      root.payload.issuer !== this.config.github.issuer
    )
      throw new Error('Original GitHub App identity unavailable')
    const previous = root.payload.applications
    if (
      previous !== undefined &&
      (!Array.isArray(previous) ||
        new Set(previous).size !== previous.length ||
        previous.some((id) => typeof id !== 'string' || !ids.includes(id)))
    )
      throw new Error('Original GitHub App identities changed')
    if (JSON.stringify(previous) === JSON.stringify(ids)) return
    // App configuration is execution state; ingress permits only delivery records.
    await this.state.commit(lease, [
      { key: root.key, expected: root.version, payload: { ...root.payload, applications: ids } },
    ])
  }
  async discover(lease: ExecutionLease, signal: AbortSignal, request: DiscoveryRequest): Promise<DiscoverySnapshot> {
    if (this.directory) {
      await this.registerApplications(lease)
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
    const applications = [...this.applications.values()]
    const groups = await Promise.all(
      applications.map(async (app) => ({ app, installations: await app.appSource().installations(signal) })),
    )
    const originalApps = new Map<number, string>()
    const installations = groups.flatMap(({ app, installations }) =>
      installations.filter((installation) => {
        if (originalApps.has(installation.id)) throw new Error('Duplicate installation identity')
        originalApps.set(installation.id, app.clientId)
        return !installation.suspended && (!app.accountType || app.accountType === installation.account.type)
      }),
    )
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
      {
        key: 'binding/self/current',
        expected: prior?.version ?? null,
        payload: { accounts, applications: Object.fromEntries(originalApps) },
      },
    ])
    return installations.map((installation) => ({
      ...this.owner(),
      installation,
      application: originalApps.get(installation.id),
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
    const client = (binding as DirectoryBinding & { application: string }).application
    const app = this.applications.get(client)
    if (!app) throw new Error('Original App unavailable')
    const id = binding.installation.id,
      previous = this.pending.get(id)
    if (previous) {
      await previous.close()
      this.pending.delete(id)
    }
    const provider = new ListenerCredentials(this.state, lease, 'catalog/' + id, {
      kind: 'app',
      app: app.appSource(),
      installation: binding.installation,
    })
    this.pending.set(id, provider)
    try {
      const scopes = await new InstallationCatalog(provider, binding, binding.policy).load(signal)
      for (const scope of scopes) await this.scopes().define(lease, scope, client)
      return scopes
    } finally {
      await provider.close()
      this.pending.delete(id)
    }
  }
  private owner() {
    return { organization: this.boxes.http.principal.path_prefix, actor: this.boxes.http.principal.sub }
  }
  private async admit(scope: ExecutionScope, source?: GitHubAppSource, signal?: AbortSignal): Promise<void> {
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
    const auth = this.config.github
    const app = auth.kind === 'app' ? this.applications.get(await this.scopes().application(lease, scope)) : undefined
    if (auth.kind === 'app' && !app) throw new Error('Original GitHub App unavailable')
    const source: CredentialSource = app
      ? {
          kind: 'app',
          app: app.appSource(),
          installation: { ...scope.installation, permissions: {}, suspended: false },
        }
      : auth.kind === 'pat' && scope.runners.kind === 'repository'
        ? { kind: 'pat', repository: scope.runners.repository.id, token: auth.token }
        : (() => {
            throw new Error('Original GitHub source unavailable')
          })()
    const admit = async (signal?: AbortSignal) => {
      if (app?.accountType && app.accountType !== scope.installation.account.type)
        throw new Error('GitHub App account type denied')
      await this.admit(scope, app?.appSource(), signal)
    }
    const workers = this.boxes.bind(scope, lease, () => admit())
    return new GitHubExecutionBackend(
      this.state,
      lease,
      scope,
      source,
      {
        workers,
        authorize: async (original, operation, signal) => {
          if (operation === 'admission') await admit(signal)
        },
      },
      this.config.worker.labels,
    )
  }
  async accept(notification: VerifiedWebhook): Promise<'stored' | 'duplicate'> {
    const client =
      notification.application ?? (this.applications.size === 1 ? [...this.applications.keys()][0] : undefined)
    if (!client || !this.applications.has(client)) throw new Error('Verified webhook App required')
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
            const provenance =
              current && object(current.payload) && object(current.payload.applications)
                ? current.payload.applications
                : undefined
            if (bound !== undefined && provenance?.[String(hint.installationId)] !== client)
              throw new Error('Original webhook App changed')
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
