/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import {
  decodeScope,
  AppDeliveryRecovery,
  ExecutionJournal,
  ExecutionLease,
  ExecutionScope,
  GitHubAppSource,
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
  PostgresStateDatabase,
  VerifiedWebhook,
  WorkerEvent,
} from '@boxlite-ai/ci-listener'
import { TypedConfigService } from '../config/typed-config.service'
import { CiGitHubService } from './ci-github.service'
import { CiNativeState, CiNativeAuthority } from './ci-native-state'
import { CiNativeWorkers } from './ci-native-workers'

type Binding = {
  id: string
  generation: string
  installation_id: string
  account_id: string
  account_login: string
  account_type: 'User' | 'Organization'
  organization_id: string
  actor_id: string
  allow_public: boolean
}
const authority = (row: Binding): CiNativeAuthority => ({
  binding: row.id,
  generation: Number(row.generation),
  organization: row.organization_id,
  actor: row.actor_id,
  installation: {
    id: Number(row.installation_id),
    account: { id: Number(row.account_id), login: row.account_login.toLowerCase(), type: row.account_type },
  },
  runners: { allowPublic: row.allow_public },
})

/** Stored connect bindings choose tenants; a webhook never supplies execution identity. */
@Injectable()
export class CiNativeHost implements ListenerHost {
  readonly recovery?: AppDeliveryRecovery
  private readonly logger = new Logger(CiNativeHost.name)
  private source?: GitHubAppSource
  private readonly pending = new Map<number, ListenerCredentials>()
  private readonly directory: InstallationDirectory
  constructor(
    private readonly db: DataSource,
    private readonly store: CiNativeState,
    private readonly workers: CiNativeWorkers,
    private readonly github: CiGitHubService,
    private readonly config: TypedConfigService,
  ) {
    this.directory = new InstallationDirectory({
      index: (lease, signal) => this.index(lease, signal),
      load: (binding, lease, signal) => this.catalog(binding, lease, signal),
      report: (error, operation) => this.report(error, operation),
    })
    if (store.app && config.get('ci.githubWebhookSecret'))
      this.recovery = new AppDeliveryRecovery({
        state: store.state,
        app: () => this.app(),
        authorize: (lease, installation, signal) => this.replayAuthority(lease, installation, signal),
        report: (error, operation) => this.report(error, operation),
      })
  }
  private async replayAuthority(
    lease: ExecutionLease,
    installation: number | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted()
    return this.store.transaction(async (tx, state) => {
      await this.store.root(state)
      await new ExecutionJournal(state).load(lease)
      if (installation === undefined) return true
      const [row]: Binding[] = await tx.query(
        `SELECT * FROM ci_installation_binding
        WHERE github_host='github.com' AND app_client_id=$1 AND installation_id=$2 FOR SHARE`,
        [this.store.app, installation],
      )
      if (!row) return false
      try {
        await this.store.admit(tx, authority(row))
      } catch (error) {
        if (error instanceof ForbiddenException) return false
        throw error
      }
      return true
    })
  }
  private app(): GitHubAppSource {
    return (this.source ??= this.github.appSource())
  }
  async discover(lease: ExecutionLease, signal: AbortSignal, request: DiscoveryRequest): Promise<DiscoverySnapshot> {
    return this.directory.step(lease, request, signal)
  }
  private async index(lease: ExecutionLease, signal: AbortSignal): Promise<DirectoryBinding[]> {
    await this.store.transaction(async (_tx, state) => {
      await this.store.root(state)
      await new ExecutionJournal(state).load(lease)
    })
    const rows: Binding[] = await this.db.query(
      `SELECT * FROM ci_installation_binding
      WHERE github_host='github.com' AND app_client_id=$1 AND follow_installation=true
      AND state IN ('provisioning','ready') ORDER BY organization_id,id LIMIT 10001`,
      [this.store.app],
    )
    signal.throwIfAborted()
    if (rows.length > 10000) throw new ServiceUnavailableException('CI binding capacity exceeded')
    return rows.map((row) => {
      const original = authority(row)
      return {
        binding: original.binding,
        generation: original.generation,
        organization: original.organization,
        actor: original.actor,
        installation: { ...original.installation, permissions: {}, suspended: false },
        policy: { allowPublic: row.allow_public, group: this.config.get('ci.workerGroup') || 'boxlite-ci-runner' },
      }
    })
  }
  private async catalog(
    binding: DirectoryBinding,
    lease: ExecutionLease,
    signal: AbortSignal,
  ): Promise<ExecutionScope[]> {
    const original = { ...binding, runners: { allowPublic: binding.policy.allowPublic } },
      id = binding.installation.id,
      previous = this.pending.get(id)
    if (previous) {
      await previous.close()
      this.pending.delete(id)
    }
    await this.store.transaction(async (tx, state) => {
      await new ExecutionJournal(state).load(lease)
      await this.store.root(state)
      await this.store.admit(tx, original)
    })
    const installation = await this.app().installation(id, signal),
      expected = original.installation.account
    if (
      installation.suspended ||
      installation.account.id !== expected.id ||
      installation.account.login.toLowerCase() !== expected.login.toLowerCase() ||
      installation.account.type !== expected.type
    )
      throw new ForbiddenException('Original GitHub installation authority changed')
    const provider = new ListenerCredentials(
      this.store.state,
      lease,
      'catalog/' + binding.binding + '/' + binding.generation,
      { kind: 'app', app: this.app(), installation },
    )
    this.pending.set(id, provider)
    let scopes: ExecutionScope[]
    try {
      scopes = await new InstallationCatalog(provider, { ...binding, installation }, binding.policy).load(signal)
    } finally {
      await provider.close()
      this.pending.delete(id)
    }
    signal.throwIfAborted()
    for (const scope of scopes) await new ExecutionJournal(this.store.state).define(lease, scope)
    await this.store.transaction(async (tx, state) => {
      await new ExecutionJournal(state).load(lease)
      await this.store.root(state)
      await this.store.admit(tx, original)
      await tx.query(
        "UPDATE ci_installation_binding SET state='ready' WHERE id=$1 AND generation=$2 AND state='provisioning'",
        [binding.binding, binding.generation],
      )
    })
    return scopes
  }
  async backend(original: ExecutionScope, lease: ExecutionLease): Promise<ListenerBackend> {
    const scope = decodeScope(original)
    return new GitHubExecutionBackend(
      this.store.state,
      lease,
      scope,
      { kind: 'app', app: this.app(), installation: { ...scope.installation, permissions: {}, suspended: false } },
      {
        workers: this.workers.open(scope, lease),
        authorize: async (current, operation, signal) => {
          signal?.throwIfAborted()
          await this.store.transaction(async (tx, state) => {
            await this.store.root(state)
            if (operation === 'admission') await this.store.admit(tx, current)
          })
        },
      },
      ['self-hosted', 'linux', 'x64', 'boxlite-ci-runner'],
    )
  }
  async accept(notification: VerifiedWebhook): Promise<'stored' | 'duplicate'> {
    const captured = {
      ...notification,
      hint: { ...notification.hint, job: notification.hint.job ? { ...notification.hint.job } : null },
    }
    const database = new PostgresStateDatabase({
      transaction: (isolation, work) =>
        this.db.transaction(isolation, async (tx) => {
          await tx.query("SET LOCAL statement_timeout='4s'")
          await tx.query("SET LOCAL lock_timeout='2s'")
          await this.store.root(this.store.inside(tx))
          const hint = captured.hint
          const [row]: Binding[] = await tx.query(
            `SELECT * FROM ci_installation_binding
          WHERE github_host='github.com' AND app_client_id=$1 AND installation_id=$2 FOR SHARE`,
            [this.store.app, hint.installationId],
          )
          if (row && Number(row.account_id) !== hint.accountId)
            throw new ForbiddenException('Original CI account changed')
          if (hint.repositoryId !== 0) {
            if (!row) throw new ForbiddenException('CI installation is not connected')
            await this.store.admit(tx, authority(row))
          }
          return work(tx)
        }),
    })
    return new ListenerInbox(new ListenerState(database, this.store.namespace)).receive(captured)
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([this.recovery?.close(), this.directory.close()])
    const failures: unknown[] = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    for (const [id, credential] of this.pending)
      try {
        await credential.close()
        this.pending.delete(id)
      } catch (error) {
        failures.push(error)
      }
    if (failures.length) throw new AggregateError(failures, 'CI catalog credential retirement failed')
  }
  report(error: unknown, operation: string): void {
    this.logger.warn({ operation, error: error instanceof Error ? error.name : 'Unknown' })
  }
  observe(event: WorkerEvent): void {
    if (event.level === 'warn') this.logger.warn(event)
    else this.logger.log(event)
  }
}
