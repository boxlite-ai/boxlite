/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'
import {
  ExecutionJournal,
  ExecutionScope,
  ListenerState,
  PostgresStateDatabase,
  StateConflict,
} from '@boxlite-ai/ci-listener'
import { TypedConfigService } from '../config/typed-config.service'
export type CiNativeAuthority = Pick<
  ExecutionScope,
  'binding' | 'generation' | 'organization' | 'actor' | 'installation'
> & {
  runners: { allowPublic: boolean }
}

/** One PostgreSQL namespace for all bindings of the configured hosted App. */
@Injectable()
export class CiNativeState {
  readonly app: string
  readonly namespace: string
  readonly state: ListenerState
  constructor(
    private readonly db: DataSource,
    config: TypedConfigService,
  ) {
    this.app = config.get('ci.githubClientId') || ''
    if (this.app && !/^[A-Za-z0-9_-]{1,128}$/.test(this.app)) throw new Error('Invalid hosted CI App identity')
    this.namespace = 'ci:' + (this.app || 'disabled')
    this.state = new ListenerState(
      new PostgresStateDatabase({
        transaction: (isolation, work) =>
          db.transaction(isolation, async (tx) => {
            await tx.query("SET LOCAL statement_timeout='4s'")
            await tx.query("SET LOCAL lock_timeout='2s'")
            return work(tx)
          }),
      }),
      this.namespace,
    )
  }
  async initialize(): Promise<void> {
    if (!this.app) throw new ServiceUnavailableException('Hosted CI App is not configured')
    await new ExecutionJournal(this.state).initialize([{ key: 'backend/native', payload: { app: this.app } }])
    await this.transaction(async (_tx, state) => this.root(state))
  }
  transaction<T>(work: (tx: EntityManager, state: ListenerState) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query("SET LOCAL statement_timeout='4s'")
      await tx.query("SET LOCAL lock_timeout='2s'")
      // Reuse the Box repository transaction: nested state operations must not
      // commit independently of the Box row or its original-ID ledger.
      return work(tx, this.inside(tx))
    })
  }
  inside(tx: EntityManager): ListenerState {
    return new ListenerState(new PostgresStateDatabase({ transaction: (_isolation, work) => work(tx) }), this.namespace)
  }
  /** Trusted connect ingress; binding authority is locked by the caller's transaction. */
  async wakeInventory(
    tx: EntityManager,
    app: string,
    installation: { installationId: number; accountId: number },
  ): Promise<void> {
    const { installationId, accountId } = installation
    if (
      app !== this.app ||
      !Number.isSafeInteger(installationId) ||
      installationId < 1 ||
      !Number.isSafeInteger(accountId) ||
      accountId < 1
    )
      throw new ForbiddenException('Original connected App installation required')
    const state = this.inside(tx),
      key = `wake/${installationId}/0`
    await this.root(state)
    for (let attempt = 0; attempt < 4; attempt++) {
      const [prior] = await state.read([key]),
        payload = prior?.payload
      if (
        prior &&
        (!payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          payload.installationId !== installationId ||
          payload.accountId !== accountId ||
          payload.repositoryId !== 0)
      )
        throw new ForbiddenException('Original inventory wake identity changed')
      try {
        // One conditional write has no partial sibling writes to undo. A CAS
        // conflict can be reread in this outer READ COMMITTED transaction.
        await state.ingest([
          { key, expected: prior?.version ?? null, payload: { installationId, accountId, repositoryId: 0 } },
        ])
        return
      } catch (error) {
        if (!(error instanceof StateConflict) || attempt === 3) throw error
      }
    }
  }
  async root(state: ListenerState): Promise<void> {
    const [root] = await state.read(['backend/native'])
    if (
      !this.app ||
      root?.schema !== 1 ||
      !root.payload ||
      typeof root.payload !== 'object' ||
      Array.isArray(root.payload) ||
      root.payload.app !== this.app
    )
      throw new ForbiddenException('Original hosted CI App identity changed')
  }
  async admit(tx: EntityManager, scope: CiNativeAuthority): Promise<void> {
    const account = scope.installation.account
    const rows = await tx.query(
      `SELECT id FROM ci_installation_binding
      WHERE id=$1 AND generation=$2 AND github_host='github.com' AND app_client_id=$3
      AND installation_id=$4 AND account_id=$5 AND lower(account_login)=$6 AND account_type=$7
      AND organization_id=$8 AND actor_id=$9 AND allow_public=$10 AND follow_installation=true
      AND state IN ('provisioning','ready') FOR SHARE`,
      [
        scope.binding,
        scope.generation,
        this.app,
        scope.installation.id,
        account.id,
        account.login,
        account.type,
        scope.organization,
        scope.actor,
        scope.runners.allowPublic,
      ],
    )
    if (rows.length !== 1) throw new ForbiddenException('Original hosted CI binding is no longer active')
    const [user] = await tx.query('SELECT role FROM "user" WHERE id=$1 FOR SHARE', [scope.actor])
    if (!user) throw new ForbiddenException('Original CI actor is unavailable')
    if (user.role !== 'admin') {
      const owners = await tx.query(
        `SELECT role FROM organization_user
        WHERE "organizationId"=$1 AND "userId"=$2 AND role='owner' FOR SHARE`,
        [scope.organization, scope.actor],
      )
      if (owners.length !== 1) throw new ForbiddenException('Current CI owner authority required')
    }
  }
}
