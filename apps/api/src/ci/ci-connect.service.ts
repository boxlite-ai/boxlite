/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { CiGitHubService, CiInstallationRequired, VerifiedInstallation } from './ci-github.service'
import { CiSecretsService } from './ci-secrets.service'
import { CiNativeState } from './ci-native-state'
import { CiSettingsService } from './ci-settings.service'
import { matchesWebState, webAuthorization } from './ci-web-authorization'

type Actor = { organizationId: string; userId: string; apiKey?: { keyHash: string } }
export type WebConnectInput = {
  account_type: 'User' | 'Organization'
  follow_installation: true
  allow_public_repositories: boolean
}
export type ConnectInput = { github_account: string; follow_installation: true; allow_public_repositories: boolean }
type Attempt = {
  id: string
  organization_id: string
  user_id: string
  github_account: string
  allow_public: boolean
  app_client_id: string
  flow: 'device' | 'web'
  oauth_state_hash: string | null
  oauth_verifier_ciphertext: string | null
  oauth_token_ciphertext: string | null
  device_ciphertext: string | null
  state: string
  expires_at: Date
  next_poll_at: Date
  interval_seconds: number
  lease_id: string | null
  lease_until: Date | null
  binding_id: string | null
}

@Injectable()
export class CiConnectService {
  constructor(
    private readonly db: DataSource,
    private readonly github: CiGitHubService,
    private readonly secrets: CiSecretsService,
    private readonly native: CiNativeState,
    private readonly settings: CiSettingsService,
  ) {}

  private async query(db: DataSource | EntityManager, sql: string, parameters: unknown[] = []): Promise<any[]> {
    try {
      const result = await db.query(sql, parameters)
      return Array.isArray(result[0]) && typeof result[1] === 'number' ? result[0] : result
    } catch {
      throw new InternalServerErrorException('CI persistence unavailable')
    }
  }

  private actor(actor: Actor) {
    if (!actor.userId || !actor.organizationId)
      throw new ForbiddenException('An authenticated organization actor is required')
  }
  private aad(row: Pick<Attempt, 'id' | 'user_id' | 'organization_id'>) {
    return JSON.stringify([row.id, row.user_id, row.organization_id])
  }

  async start(actor: Actor, input: ConnectInput) {
    this.actor(actor)
    const app = await this.github.forAccount(input.github_account)
    const settings = app.settings()
    // Erase expired credentials even when nobody polls their abandoned attempt.
    await this.query(
      this.db,
      `UPDATE ci_connect_attempt SET state='expired',device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL
      WHERE expires_at<=clock_timestamp() AND (device_ciphertext IS NOT NULL OR oauth_verifier_ciphertext IS NOT NULL OR oauth_token_ciphertext IS NOT NULL)`,
    )
    const grant = await app.startDevice()
    const id = randomUUID()
    const expires = new Date(Date.now() + Math.min(grant.expires_in, 900) * 1000)
    const ciphertext = this.secrets.seal(
      grant.device_code,
      this.aad({ id, user_id: actor.userId, organization_id: actor.organizationId }),
    )
    await this.query(
      this.db,
      `INSERT INTO ci_connect_attempt
      (id,organization_id,user_id,github_account,allow_public,app_client_id,device_ciphertext,expires_at,next_poll_at,interval_seconds)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+($9*interval '1 second'),$9)`,
      [
        id,
        actor.organizationId,
        actor.userId,
        input.github_account,
        input.allow_public_repositories,
        settings.clientId,
        ciphertext,
        expires,
        grant.interval,
      ],
    )
    return {
      id,
      status: 'pending',
      user_code: grant.user_code,
      verification_uri: grant.verification_uri,
      installation_url: settings.installationUrl,
      expires_at: expires.toISOString(),
      interval: grant.interval,
    }
  }

  configuration() {
    return {
      apps: this.github.configured().map((app) => {
        let available = false
        try {
          app.webSettings()
          available = true
        } catch {
          /* Device Flow can remain available. */
        }
        return {
          account_type: app.accountType,
          installation_url: app.settings().installationUrl,
          web_connect_available: available,
        }
      }),
    }
  }

  async startWeb(actor: Actor, input: WebConnectInput) {
    this.actor(actor)
    actor = { ...actor, apiKey: actor.apiKey ? { ...actor.apiKey } : undefined }
    input = { ...input }
    const app = this.github.forType(input.account_type)
    const settings = app.webSettings()
    const id = randomUUID(),
      authorization = webAuthorization(id)
    const expires = new Date(Date.now() + 300000)
    const ciphertext = this.secrets.seal(
      authorization.verifier,
      this.aad({ id, user_id: actor.userId, organization_id: actor.organizationId }) + ':web-pkce',
    )
    await this.query(
      this.db,
      `UPDATE ci_connect_attempt SET state='expired',device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL
      WHERE expires_at<=clock_timestamp() AND (device_ciphertext IS NOT NULL OR oauth_verifier_ciphertext IS NOT NULL OR oauth_token_ciphertext IS NOT NULL)`,
    )
    await this.query(
      this.db,
      `INSERT INTO ci_connect_attempt(id,organization_id,user_id,github_account,allow_public,app_client_id,
      flow,oauth_state_hash,oauth_verifier_ciphertext,expires_at,next_poll_at,interval_seconds)
      VALUES($1,$2,$3,$4,$5,$6,'web',$7,$8,$9,now(),1)`,
      [
        id,
        actor.organizationId,
        actor.userId,
        '',
        input.allow_public_repositories,
        settings.clientId,
        authorization.stateHash,
        ciphertext,
        expires,
      ],
    )
    return {
      id,
      status: 'pending',
      expires_at: expires.toISOString(),
      installation_url: settings.installationUrl,
      authorization_url: app.authorizeWeb(authorization.state, authorization.challenge),
    }
  }

  async completeWeb(actor: Actor, id: string, input: { code: string; state: string }) {
    this.actor(actor)
    actor = { ...actor, apiKey: actor.apiKey ? { ...actor.apiKey } : undefined }
    // Capture before the transaction awaits; never persist the authorization code.
    const code = input.code,
      state = input.state,
      lease = randomUUID()
    const row: Attempt = await this.db.transaction(async (tx) => {
      const [current] = await this.query(
        tx,
        `SELECT *,expires_at>clock_timestamp() AS live,lease_until>clock_timestamp() AS lease_live
        FROM ci_connect_attempt WHERE id=$1 AND organization_id=$2 AND user_id=$3 FOR UPDATE`,
        [id, actor.organizationId, actor.userId],
      )
      if (!current) throw new NotFoundException('Connect attempt not found')
      if (current.flow !== 'web' || !matchesWebState(id, state, current.oauth_state_hash))
        throw new ForbiddenException('GitHub connect state mismatch')
      if (['done', 'failed', 'cancelled', 'expired', 'installation_required'].includes(current.state)) return current
      if (!current.live || (current.state === 'polling' && !current.lease_live)) {
        const status = current.live ? 'failed' : 'expired'
        await this.query(
          tx,
          `UPDATE ci_connect_attempt SET state=$2,device_ciphertext=NULL,
          oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1`,
          [id, status],
        )
        return {
          ...current,
          state: status,
          lease_id: null,
          oauth_verifier_ciphertext: null,
          oauth_token_ciphertext: null,
        }
      }
      await this.assertCurrentAuthority(tx, actor)
      if (current.state === 'polling' || current.state === 'selecting') return current
      await this.query(
        tx,
        `UPDATE ci_connect_attempt SET state='polling',lease_id=$2,
        lease_until=clock_timestamp()+interval '90 seconds',oauth_verifier_ciphertext=NULL WHERE id=$1`,
        [id, lease],
      )
      return { ...current, state: 'polling', lease_id: lease }
    })
    if (row.lease_id !== lease) return this.response(row, actor, state)
    try {
      const app = this.github.byClientId(row.app_client_id)
      if (!row.oauth_verifier_ciphertext) throw new ForbiddenException('App configuration changed; reconnect')
      const verifier = this.secrets.open(row.oauth_verifier_ciphertext, this.aad(row) + ':web-pkce')
      const token = await app.exchangeWeb(code, verifier)
      await this.db.transaction(async (tx) => {
        const [current] = await this.query(
          tx,
          `SELECT id FROM ci_connect_attempt WHERE id=$1
          AND state='polling' AND lease_id=$2 AND expires_at>clock_timestamp()
          AND lease_until>clock_timestamp() FOR UPDATE`,
          [id, lease],
        )
        if (!current) return
        await this.assertCurrentAuthority(tx, actor)
        await this.query(
          tx,
          `UPDATE ci_connect_attempt SET state='selecting',oauth_token_ciphertext=$3,
          lease_id=NULL,lease_until=NULL WHERE id=$1 AND state='polling' AND lease_id=$2
          AND expires_at>clock_timestamp() AND lease_until>clock_timestamp()`,
          [id, lease, this.secrets.seal(token, this.aad(row) + ':web-selection')],
        )
      })
    } catch (error) {
      // An uncertain exchange is terminal: reusing the code can produce another remote effect.
      await this.terminal(id, lease, error instanceof CiInstallationRequired ? 'installation_required' : 'failed')
    }
    const [latest] = await this.query(
      this.db,
      'SELECT * FROM ci_connect_attempt WHERE id=$1 AND organization_id=$2 AND user_id=$3',
      [id, actor.organizationId, actor.userId],
    )
    if (!latest) throw new NotFoundException('Connect attempt not found')
    return this.response(latest, actor, state)
  }

  async selectWeb(actor: Actor, id: string, installation: number, installState?: string) {
    this.actor(actor)
    actor = { ...actor, apiKey: actor.apiKey ? { ...actor.apiKey } : undefined }
    const selected = installation,
      state = installState,
      lease = randomUUID()
    if (!Number.isSafeInteger(selected) || selected < 1) throw new ForbiddenException('Invalid GitHub installation')
    const row: Attempt = await this.db.transaction(async (tx) => {
      const [current] = await this.query(
        tx,
        `SELECT *,expires_at>clock_timestamp() AS live,
        lease_until>clock_timestamp() AS lease_live FROM ci_connect_attempt
        WHERE id=$1 AND organization_id=$2 AND user_id=$3 FOR UPDATE`,
        [id, actor.organizationId, actor.userId],
      )
      if (!current) throw new NotFoundException('Connect attempt not found')
      if (current.flow !== 'web' || (state !== undefined && !matchesWebState(id, state, current.oauth_state_hash)))
        throw new ForbiddenException('GitHub connect state mismatch')
      await this.assertCurrentAuthority(tx, actor)
      if (['done', 'failed', 'expired', 'cancelled'].includes(current.state)) return current
      if (!current.live || (current.state === 'polling' && !current.lease_live)) {
        const status = current.live ? 'failed' : 'expired'
        await this.query(
          tx,
          `UPDATE ci_connect_attempt SET state=$2,oauth_token_ciphertext=NULL,
          oauth_verifier_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1`,
          [id, status],
        )
        return { ...current, state: status, lease_id: null, oauth_token_ciphertext: null }
      }
      if (current.state === 'polling') return current
      if (current.state !== 'selecting' || !current.oauth_token_ciphertext)
        throw new ConflictException('GitHub authorization is required before selecting an account')
      await this.query(
        tx,
        `UPDATE ci_connect_attempt SET state='polling',lease_id=$2,
        lease_until=clock_timestamp()+interval '90 seconds',oauth_token_ciphertext=NULL WHERE id=$1`,
        [id, lease],
      )
      return { ...current, state: 'polling', lease_id: lease }
    })
    if (row.lease_id !== lease) return this.response(row, actor)
    try {
      const app = this.github.byClientId(row.app_client_id)
      const token = this.secrets.open(row.oauth_token_ciphertext!, this.aad(row) + ':web-selection')
      const verified = await app.verifyUserInstallation(token, selected)
      if (verified.installationId !== selected) throw new ForbiddenException('Original installation changed')
      await this.bind(row, lease, verified, actor)
    } catch {
      await this.terminal(id, lease, 'failed')
    }
    const [latest] = await this.query(
      this.db,
      'SELECT * FROM ci_connect_attempt WHERE id=$1 AND organization_id=$2 AND user_id=$3',
      [id, actor.organizationId, actor.userId],
    )
    if (!latest) throw new NotFoundException('Connect attempt not found')
    return this.response(latest, actor)
  }

  async cancel(actor: Actor, id: string) {
    this.actor(actor)
    const rows = await this.query(
      this.db,
      `UPDATE ci_connect_attempt SET state=CASE WHEN state='done' THEN state ELSE 'cancelled' END,
      device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1 AND organization_id=$2 AND user_id=$3 RETURNING *`,
      [id, actor.organizationId, actor.userId],
    )
    if (!rows.length) throw new NotFoundException('Connect attempt not found')
    return this.response(rows[0], actor)
  }

  async poll(actor: Actor, id: string) {
    this.actor(actor)
    const lease = randomUUID()
    const row: Attempt = await this.db.transaction(async (tx) => {
      const [current]: Attempt[] = await this.query(
        tx,
        'SELECT * FROM ci_connect_attempt WHERE id=$1 AND organization_id=$2 AND user_id=$3 FOR UPDATE',
        [id, actor.organizationId, actor.userId],
      )
      if (!current) throw new NotFoundException('Connect attempt not found')
      if (current.flow !== 'device')
        throw new ForbiddenException('Browser authorization requires its completion endpoint')
      if (['done', 'failed', 'cancelled', 'expired', 'installation_required'].includes(current.state)) return current
      if (
        current.expires_at.getTime() <= Date.now() ||
        (current.state === 'polling' && current.lease_until!.getTime() <= Date.now())
      ) {
        const state = current.expires_at.getTime() <= Date.now() ? 'expired' : 'failed'
        await this.query(
          tx,
          'UPDATE ci_connect_attempt SET state=$2,device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1',
          [id, state],
        )
        return { ...current, state, device_ciphertext: null, lease_id: null }
      }
      if (current.state === 'polling' || current.next_poll_at.getTime() > Date.now()) return current
      const [claimed] = await this.query(
        tx,
        `UPDATE ci_connect_attempt SET state='polling',lease_id=$2,lease_until=now()+interval '90 seconds'
        WHERE id=$1 RETURNING *`,
        [id, lease],
      )
      return claimed
    })
    if (row.lease_id !== lease) return this.response(row, actor)
    try {
      const app = this.github.byClientId(row.app_client_id)
      if (!row.device_ciphertext) throw new ForbiddenException('App configuration changed; reconnect')
      const result = await app.pollDevice(this.secrets.open(row.device_ciphertext, this.aad(row)))
      if (result.error === 'authorization_pending' || result.error === 'slow_down') {
        const interval = row.interval_seconds + (result.error === 'slow_down' ? 5 : 0)
        await this.query(
          this.db,
          `UPDATE ci_connect_attempt SET state='pending',interval_seconds=$3,
          next_poll_at=now()+($3::integer*interval '1 second'),lease_id=NULL,lease_until=NULL WHERE id=$1 AND state='polling' AND lease_id=$2`,
          [id, lease, interval],
        )
      } else if (typeof result.access_token === 'string' && result.access_token.length > 0) {
        const verified = await app.verifyUserInstallation(result.access_token, row.github_account)
        await this.bind(row, lease, verified, actor)
      } else await this.terminal(id, lease, result.error === 'expired_token' ? 'expired' : 'failed')
    } catch (error) {
      await this.terminal(id, lease, error instanceof CiInstallationRequired ? 'installation_required' : 'failed')
      // Do not log upstream errors: OAuth and SQL errors can carry credential data.
    }
    const [latest] = await this.query(
      this.db,
      'SELECT * FROM ci_connect_attempt WHERE id=$1 AND organization_id=$2 AND user_id=$3',
      [id, actor.organizationId, actor.userId],
    )
    if (!latest) throw new NotFoundException('Connect attempt not found')
    return this.response(latest, actor)
  }

  private terminal(id: string, lease: string, status: string) {
    return this.query(
      this.db,
      `UPDATE ci_connect_attempt SET state=$3,device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,lease_id=NULL,lease_until=NULL
      WHERE id=$1 AND state='polling' AND lease_id=$2`,
      [id, lease, status],
    )
  }

  private async assertCurrentAuthority(tx: EntityManager, actor: Actor) {
    const [user] = await this.query(tx, 'SELECT role FROM "user" WHERE id=$1 FOR SHARE', [actor.userId])
    if (!user) throw new ForbiddenException('CI actor is no longer available')
    if (user.role !== 'admin') {
      const [owner] = await this.query(
        tx,
        `SELECT role FROM organization_user WHERE "organizationId"=$1 AND "userId"=$2 AND role='owner' FOR SHARE`,
        [actor.organizationId, actor.userId],
      )
      if (!owner) throw new ForbiddenException('Current organization owner authority is required')
    }
    if (!actor.apiKey) return
    if (!/^[a-f0-9]{64}$/.test(actor.apiKey.keyHash || ''))
      throw new ForbiddenException('Verified API key identity is required')
    const [key] = await this.query(
      tx,
      `SELECT permissions FROM api_key WHERE "keyHash"=$1 AND "userId"=$2 AND "organizationId"=$3 FOR SHARE`,
      [actor.apiKey.keyHash, actor.userId, actor.organizationId],
    )
    if (
      !key ||
      !Array.isArray(key.permissions) ||
      !['write:boxes', 'delete:boxes'].every((p) => key.permissions.includes(p))
    )
      throw new ForbiddenException('Current API key Box permissions are required')
  }

  private async bind(attempt: Attempt, lease: string, verified: VerifiedInstallation, actor: Actor) {
    await this.db.transaction(async (tx) => {
      await this.query(tx, "SET LOCAL lock_timeout='2s'")
      await this.query(tx, "SET LOCAL statement_timeout='4s'")
      const [current] = await this.query(
        tx,
        `SELECT * FROM ci_connect_attempt WHERE id=$1 AND state='polling' AND lease_id=$2
        AND expires_at>clock_timestamp() AND lease_until>clock_timestamp() FOR UPDATE`,
        [attempt.id, lease],
      )
      if (!current) return
      await this.assertCurrentAuthority(tx, actor)
      await this.settings.ensure(tx, attempt.organization_id)
      await this.query(
        tx,
        `INSERT INTO ci_installation_binding
        (id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation,allow_public)
        VALUES ($1,'github.com',$2,$3,$4,$5,$6,$7,$8,true,$9)
        ON CONFLICT (github_host,app_client_id,installation_id) DO NOTHING`,
        [
          randomUUID(),
          attempt.app_client_id,
          verified.installationId,
          verified.accountId,
          verified.accountLogin,
          verified.accountType,
          attempt.organization_id,
          attempt.user_id,
          attempt.allow_public,
        ],
      )
      const [binding] = await this.query(
        tx,
        `SELECT * FROM ci_installation_binding
        WHERE github_host='github.com' AND app_client_id=$1 AND installation_id=$2 FOR UPDATE`,
        [attempt.app_client_id, verified.installationId],
      )
      if (
        binding.organization_id !== attempt.organization_id ||
        Number(binding.account_id) !== verified.accountId ||
        binding.account_type !== verified.accountType ||
        binding.allow_public !== attempt.allow_public ||
        !binding.follow_installation
      )
        throw new ConflictException('Installation is already bound with a different owner or policy')
      await this.native.wakeInventory(tx, attempt.app_client_id, verified)
      // now() is transaction-start time. Row-lock waits can cross any deadline,
      // so the final write is the authorization decision's clock-time boundary.
      const completed = await this.query(
        tx,
        `UPDATE ci_connect_attempt SET state='done',binding_id=$2,device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,lease_id=NULL,lease_until=NULL
        WHERE id=$1 AND state='polling' AND lease_id=$3
        AND expires_at>clock_timestamp() AND lease_until>clock_timestamp()
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM api_key WHERE "keyHash"=$4
          AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp()))) RETURNING id`,
        [attempt.id, binding.id, lease, actor.apiKey?.keyHash ?? null],
      )
      if (completed.length !== 1) throw new ForbiddenException('CI authorization expired before binding completed')
    })
  }

  private async response(row: Attempt, actor: Actor, installState?: string) {
    if (row.state === 'selecting') {
      const current: Attempt | undefined = await this.db.transaction(async (tx) => {
        const [value] = await this.query(
          tx,
          `SELECT *,expires_at>clock_timestamp() AS live FROM ci_connect_attempt
          WHERE id=$1 AND organization_id=$2 AND user_id=$3 FOR UPDATE`,
          [row.id, actor.organizationId, actor.userId],
        )
        if (!value) throw new NotFoundException('Connect attempt not found')
        await this.assertCurrentAuthority(tx, actor)
        if (value.state !== 'selecting') return value
        if (!value.live) {
          await this.query(
            tx,
            `UPDATE ci_connect_attempt SET state='expired',oauth_token_ciphertext=NULL WHERE id=$1`,
            [row.id],
          )
          return { ...value, state: 'expired', oauth_token_ciphertext: null }
        }
        return value
      })
      if (current!.state !== 'selecting') return this.response(current!, actor)
      if (!current!.oauth_token_ciphertext) throw new ForbiddenException('Selection credentials unavailable')
      const app = this.github.byClientId(current!.app_client_id)
      const token = this.secrets.open(current!.oauth_token_ciphertext, this.aad(current!) + ':web-selection')
      const accounts = await app.availableInstallations(token)
      const url = new URL(app.settings().installationUrl)
      if (installState && matchesWebState(row.id, installState, current!.oauth_state_hash))
        url.searchParams.set('state', installState)
      return {
        id: row.id,
        status: 'selection_required',
        expires_at: current!.expires_at.toISOString(),
        installation_url: url.href,
        accounts: accounts.map((choice) => ({
          installation_id: choice.installationId,
          account_id: choice.accountId,
          github_account: choice.accountLogin,
          account_type: choice.accountType,
        })),
      }
    }
    if (row.state === 'done') {
      const [binding] = await this.query(
        this.db,
        'SELECT id,state,account_login,allow_public FROM ci_installation_binding WHERE id=$1 AND organization_id=$2',
        [row.binding_id, row.organization_id],
      )
      if (!binding) throw new NotFoundException('CI binding unavailable')
      return {
        id: row.id,
        status: 'connected',
        binding_id: binding.id,
        listener_status: binding.state,
        github_account: binding.account_login,
        runs_on: 'boxlite-ci-runner',
        allow_public_repositories: binding.allow_public,
      }
    }
    return {
      id: row.id,
      status: row.state === 'polling' ? 'pending' : row.state,
      interval: row.interval_seconds,
      expires_at: row.expires_at.toISOString(),
      ...(row.state === 'installation_required'
        ? {
            installation_url: this.github.byClientId(row.app_client_id).settings().installationUrl,
            reason: 'Install the App, then start connect again for a new GitHub authorization.',
          }
        : {}),
    }
  }
}
