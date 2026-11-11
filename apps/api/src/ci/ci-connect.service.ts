/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  ConflictException,
  HttpException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { installationSettingsUrl, type GitHubAccount } from '@boxlite-ai/ci-listener'
import { DataSource, EntityManager } from 'typeorm'
import { CiGitHubService, CiInstallationRequired, VerifiedInstallation } from './ci-github.service'
import { CiSecretsService } from './ci-secrets.service'
import { CiNativeState } from './ci-native-state'
import { CiSettingsService } from './ci-settings.service'
import { matchesWebState, webAuthorization } from './ci-web-authorization'

type Actor = { organizationId: string; userId: string; apiKey?: { keyHash: string } }
export type WebConnectInput = {
  account_type?: 'User' | 'Organization'
  select_account?: boolean
  follow_installation: true
  allow_private_repositories: boolean
}
export type ConnectInput = { github_account: string; follow_installation: true; allow_private_repositories: boolean }
type WebTarget = { clientId: string; account: GitHubAccount; state: string }
type Attempt = {
  id: string
  organization_id: string
  user_id: string
  github_account: string
  allow_private: boolean
  app_client_id: string
  flow: 'device' | 'web'
  oauth_state_hash: string | null
  oauth_verifier_ciphertext: string | null
  oauth_token_ciphertext: string | null
  web_target_ciphertext: string | null
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
      `UPDATE ci_connect_attempt SET state='expired',device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL
      WHERE expires_at<=clock_timestamp() AND (device_ciphertext IS NOT NULL OR oauth_verifier_ciphertext IS NOT NULL OR oauth_token_ciphertext IS NOT NULL OR web_target_ciphertext IS NOT NULL)`,
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
      (id,organization_id,user_id,github_account,allow_private,app_client_id,device_ciphertext,expires_at,next_poll_at,interval_seconds)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+($9*interval '1 second'),$9)`,
      [
        id,
        actor.organizationId,
        actor.userId,
        input.github_account,
        input.allow_private_repositories,
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
    let web = false,
      authorizationSettingsUrl: string | undefined
    try {
      authorizationSettingsUrl = this.github.identity().webSettings().authorizationSettingsUrl
      web = true
    } catch {
      /* CI execution does not require identity OAuth. */
    }
    return {
      web_connect_available: web,
      authorization_settings_url: authorizationSettingsUrl,
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
    const app = this.github.identity()
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
      `UPDATE ci_connect_attempt SET state='expired',device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL
      WHERE expires_at<=clock_timestamp() AND (device_ciphertext IS NOT NULL OR oauth_verifier_ciphertext IS NOT NULL OR oauth_token_ciphertext IS NOT NULL OR web_target_ciphertext IS NOT NULL)`,
    )
    await this.query(
      this.db,
      `INSERT INTO ci_connect_attempt(id,organization_id,user_id,github_account,allow_private,app_client_id,
      flow,oauth_state_hash,oauth_verifier_ciphertext,expires_at,next_poll_at,interval_seconds)
      VALUES($1,$2,$3,$4,$5,$6,'web',$7,$8,$9,now(),1)`,
      [
        id,
        actor.organizationId,
        actor.userId,
        '',
        input.allow_private_repositories,
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
      authorization_url: app.authorizeWeb(authorization.state, authorization.challenge, input.select_account ?? false),
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
          oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1`,
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
      const app = this.github.authorizationApp(row.app_client_id)
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

  private async webAttempt(actor: Actor, id: string, tx?: EntityManager): Promise<Attempt> {
    if (!tx) return this.db.transaction((manager) => this.webAttempt(actor, id, manager))
    const [row] = await this.query(
      tx,
      `SELECT *,expires_at>clock_timestamp() AS live,
      lease_until>clock_timestamp() AS lease_live FROM ci_connect_attempt
      WHERE id=$1 AND organization_id=$2 AND user_id=$3 FOR UPDATE`,
      [id, actor.organizationId, actor.userId],
    )
    if (!row) throw new NotFoundException('Connect attempt not found')
    if (row.flow !== 'web') throw new ForbiddenException('Browser authorization required')
    await this.assertCurrentAuthority(tx, actor)
    if (
      !['done', 'failed', 'cancelled', 'expired'].includes(row.state) &&
      (!row.live || (row.state === 'polling' && !row.lease_live))
    ) {
      const state = row.live ? 'failed' : 'expired'
      await this.query(
        tx,
        `UPDATE ci_connect_attempt SET state=$2,device_ciphertext=NULL,
        oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,
        lease_id=NULL,lease_until=NULL WHERE id=$1`,
        [id, state],
      )
      return {
        ...row,
        state,
        oauth_token_ciphertext: null,
        web_target_ciphertext: null,
        lease_id: null,
        lease_until: null,
      }
    }
    return row
  }
  async getWeb(actor: Actor, id: string) {
    this.actor(actor)
    return this.response(await this.webAttempt(actor, id), actor)
  }
  async repositories(actor: Actor, id: string, accountId: number, page: number, limit: number) {
    this.actor(actor)
    actor = { ...actor, apiKey: actor.apiKey ? { ...actor.apiKey } : undefined }
    if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new ForbiddenException('Invalid GitHub account')
    const original = await this.webAttempt(actor, id)
    if (
      original.state !== 'selecting' ||
      !original.oauth_token_ciphertext ||
      !this.github.isIdentityClient(original.app_client_id)
    )
      throw new ForbiddenException('An active account selection is required')
    const token = this.secrets.open(original.oauth_token_ciphertext, this.aad(original) + ':web-selection')
    const inventory = await this.github.availableAccounts(original.app_client_id, token)
    const account = inventory.accounts.find((item) => item.accountId === accountId)
    if (!account?.installationId) throw new ForbiddenException('Installed owned GitHub account required')
    const result = await this.github.repositoryPage(
      account.clientId,
      {
        installationId: account.installationId,
        accountId: account.accountId,
        accountLogin: account.accountLogin,
        accountType: account.accountType,
      },
      page,
      limit,
    )
    const current = await this.webAttempt(actor, id)
    if (
      current.state !== 'selecting' ||
      current.app_client_id !== original.app_client_id ||
      current.oauth_token_ciphertext !== original.oauth_token_ciphertext
    )
      throw new ForbiddenException('GitHub authorization changed; restart connect')
    return result
  }
  private targetAad(row: Attempt) {
    return this.aad(row) + ':web-target:' + row.app_client_id
  }
  private webTarget(row: Attempt): WebTarget {
    if (!row.web_target_ciphertext) throw new ForbiddenException('No pending GitHub installation')
    let value: WebTarget
    try {
      value = JSON.parse(this.secrets.open(row.web_target_ciphertext, this.targetAad(row)))
    } catch {
      throw new ForbiddenException('GitHub installation context unavailable; restart connect')
    }
    if (
      !value ||
      typeof value.clientId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.clientId) ||
      !Number.isSafeInteger(value.account?.accountId) ||
      value.account.accountId <= 0 ||
      !['User', 'Organization'].includes(value.account.accountType) ||
      typeof value.account.accountLogin !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.account.accountLogin) ||
      typeof value.state !== 'string' ||
      !new RegExp('^' + row.id + '\\.[A-Za-z0-9_-]{43}$').test(value.state)
    )
      throw new ForbiddenException('Invalid GitHub installation context')
    return value
  }
  async completeInstallation(actor: Actor, id: string, installation: number, state: string) {
    this.actor(actor)
    const row = await this.webAttempt(actor, id)
    if (!this.github.isIdentityClient(row.app_client_id)) return this.selectWeb(actor, id, installation, state)
    return this.chooseAccount(actor, id, undefined, { installation, state })
  }
  async selectAccount(actor: Actor, id: string, input: { account_id: number; allow_private_repositories: boolean }) {
    this.actor(actor)
    return this.chooseAccount(actor, id, { ...input })
  }
  private async chooseAccount(
    actor: Actor,
    id: string,
    input?: { account_id: number; allow_private_repositories: boolean },
    callback?: { installation: number; state: string },
  ) {
    actor = { ...actor, apiKey: actor.apiKey ? { ...actor.apiKey } : undefined }
    if (
      input &&
      (!Number.isSafeInteger(input.account_id) ||
        input.account_id <= 0 ||
        typeof input.allow_private_repositories !== 'boolean')
    )
      throw new ForbiddenException('Invalid GitHub account selection')
    const lease = randomUUID()
    let row = await this.db.transaction(async (tx) => {
      const current = await this.webAttempt(actor, id, tx)
      if (!this.github.isIdentityClient(current.app_client_id))
        throw new ForbiddenException('Original identity OAuth App changed')
      if (['done', 'failed', 'cancelled', 'expired'].includes(current.state) || current.state === 'polling')
        return current
      if (current.state !== 'selecting' || !current.oauth_token_ciphertext)
        throw new ConflictException('GitHub login required before choosing an account')
      if (callback) {
        const target = this.webTarget(current)
        if (!matchesWebState(id, callback.state, createHash('sha256').update(target.state).digest('hex')))
          throw new ForbiddenException('GitHub installation state mismatch')
      }
      const claimed = await this.query(
        tx,
        `UPDATE ci_connect_attempt SET state='polling',lease_id=$2,
        lease_until=clock_timestamp()+interval '90 seconds',oauth_token_ciphertext=NULL
        WHERE id=$1 AND state='selecting' AND expires_at>clock_timestamp() RETURNING id`,
        [id, lease],
      )
      if (!claimed.length) return this.webAttempt(actor, id, tx)
      return { ...current, state: 'polling', lease_id: lease }
    })
    if (row.lease_id !== lease) return this.response(row, actor)
    let targetSaved = false
    try {
      const token = this.secrets.open(row.oauth_token_ciphertext!, this.aad(row) + ':web-selection')
      const signal = AbortSignal.timeout(45_000)
      const identity = await this.github.identity().ownedAccounts(token, signal)
      let target: WebTarget
      if (callback) target = this.webTarget(row)
      else {
        const account = identity.accounts.find((item) => item.accountId === input!.account_id)
        if (!account) throw new ForbiddenException('Current GitHub account owner required')
        target = {
          clientId: this.github.forType(account.accountType).clientId,
          account,
          state: webAuthorization(id).state,
        }
        row = {
          ...row,
          allow_private: input!.allow_private_repositories,
          web_target_ciphertext: this.secrets.seal(JSON.stringify(target), this.targetAad(row)),
        }
        const saved = await this.query(
          this.db,
          `UPDATE ci_connect_attempt SET web_target_ciphertext=$3,allow_private=$4
          WHERE id=$1 AND state='polling' AND lease_id=$2 AND expires_at>clock_timestamp()
          AND lease_until>clock_timestamp() RETURNING id`,
          [id, lease, row.web_target_ciphertext, row.allow_private],
        )
        if (!saved.length) return this.getWeb(actor, id)
        targetSaved = true
      }
      if (
        !identity.accounts.some(
          (account) =>
            account.accountId === target.account.accountId &&
            account.accountType === target.account.accountType &&
            account.accountLogin.toLowerCase() === target.account.accountLogin.toLowerCase(),
        )
      )
        throw new ForbiddenException('Current GitHub account owner required')
      const app = this.github.byClientId(target.clientId)
      const installed = await app.installationFor(target.account, signal)
      if (!installed) {
        if (callback) throw new ForbiddenException('Selected GitHub installation is unavailable')
        await this.query(
          this.db,
          `UPDATE ci_connect_attempt SET state='selecting',oauth_token_ciphertext=$3,
          lease_id=NULL,lease_until=NULL WHERE id=$1 AND state='polling' AND lease_id=$2
          AND expires_at>clock_timestamp() AND lease_until>clock_timestamp()`,
          [id, lease, row.oauth_token_ciphertext],
        )
      } else {
        if (callback && installed.installationId !== callback.installation)
          throw new ForbiddenException('GitHub installation does not match the selected account')
        await this.bind(row, lease, installed, actor, target)
      }
    } catch (error) {
      if (error instanceof HttpException && [502, 503, 504].includes(error.getStatus())) {
        await this.query(
          this.db,
          `UPDATE ci_connect_attempt SET state='selecting',oauth_token_ciphertext=$3,
          web_target_ciphertext=CASE WHEN $4::boolean THEN NULL ELSE web_target_ciphertext END,
          lease_id=NULL,lease_until=NULL WHERE id=$1 AND state='polling' AND lease_id=$2
          AND expires_at>clock_timestamp() AND lease_until>clock_timestamp()`,
          [id, lease, row.oauth_token_ciphertext, targetSaved],
        )
      } else await this.terminal(id, lease, 'failed')
      throw error
    }
    return this.getWeb(actor, id)
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
          `UPDATE ci_connect_attempt SET state=$2,oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,
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
        lease_until=clock_timestamp()+interval '90 seconds',oauth_token_ciphertext=NULL,web_target_ciphertext=NULL WHERE id=$1`,
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
      device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1 AND organization_id=$2 AND user_id=$3 RETURNING *`,
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
          'UPDATE ci_connect_attempt SET state=$2,device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id=$1',
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
      `UPDATE ci_connect_attempt SET state=$3,device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL
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

  private async bind(
    attempt: Attempt,
    lease: string,
    verified: VerifiedInstallation,
    actor: Actor,
    selection?: WebTarget,
  ) {
    const clientId = selection?.clientId ?? attempt.app_client_id
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
      if (current.app_client_id !== attempt.app_client_id)
        throw new ForbiddenException('Original OAuth identity changed')
      if (selection) {
        const target = this.webTarget(current)
        if (
          target.clientId !== selection.clientId ||
          target.state !== selection.state ||
          target.account.accountId !== verified.accountId ||
          target.account.accountType !== verified.accountType ||
          target.account.accountLogin.toLowerCase() !== verified.accountLogin.toLowerCase()
        )
          throw new ForbiddenException('Original GitHub selection changed')
      }
      await this.assertCurrentAuthority(tx, actor)
      await this.settings.ensure(tx, attempt.organization_id)
      // Serialize new and reactivated bindings across tenants before admission.
      await this.query(tx, 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        this.native.namespace + ':bindings',
      ])
      await this.query(
        tx,
        `INSERT INTO ci_installation_binding
        (id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation,allow_private)
        VALUES ($1,'github.com',$2,$3,$4,$5,$6,$7,$8,true,$9)
        ON CONFLICT (github_host,app_client_id,installation_id) DO NOTHING`,
        [
          randomUUID(),
          clientId,
          verified.installationId,
          verified.accountId,
          verified.accountLogin,
          verified.accountType,
          attempt.organization_id,
          attempt.user_id,
          attempt.allow_private,
        ],
      )
      const [binding] = await this.query(
        tx,
        `SELECT * FROM ci_installation_binding
        WHERE github_host='github.com' AND app_client_id=$1 AND installation_id=$2 FOR UPDATE`,
        [clientId, verified.installationId],
      )
      if (
        binding.organization_id !== attempt.organization_id ||
        Number(binding.account_id) !== verified.accountId ||
        binding.account_type !== verified.accountType ||
        !binding.follow_installation
      )
        throw new ConflictException('Installation is already bound with a different owner or policy')
      if (binding.state === 'disabled') {
        await this.query(
          tx,
          `UPDATE ci_installation_binding SET state='provisioning',generation=generation+1,
          actor_id=$2,allow_private=$3,account_login=$4 WHERE id=$1`,
          [binding.id, attempt.user_id, attempt.allow_private, verified.accountLogin],
        )
      } else if (!selection && binding.allow_private !== attempt.allow_private) {
        throw new ConflictException('Installation is already bound with a different owner or policy')
      }
      if (binding.state !== 'disabled' && binding.account_login !== verified.accountLogin) {
        await this.query(
          tx,
          `UPDATE ci_installation_binding SET account_login=$2,state='provisioning',generation=generation+1 WHERE id=$1`,
          [binding.id, verified.accountLogin],
        )
      }
      const [{ count }] = await this.query(
        tx,
        `SELECT count(*)::int AS count FROM ci_installation_binding WHERE github_host='github.com'
        AND app_client_id=ANY($1::text[]) AND follow_installation=true AND state IN ('provisioning','ready')`,
        [this.native.apps],
      )
      if (count > 10000) throw new ServiceUnavailableException('CI binding capacity exceeded')
      await this.native.wakeInventory(tx, clientId, verified)
      // now() is transaction-start time. Row-lock waits can cross any deadline,
      // so the final write is the authorization decision's clock-time boundary.
      const completed = await this.query(
        tx,
        `UPDATE ci_connect_attempt SET state=$5,binding_id=$2,device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,oauth_token_ciphertext=$6,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL
        WHERE id=$1 AND state='polling' AND lease_id=$3
        AND expires_at>clock_timestamp() AND lease_until>clock_timestamp()
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM api_key WHERE "keyHash"=$4
          AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp()))) RETURNING id`,
        [
          attempt.id,
          binding.id,
          lease,
          actor.apiKey?.keyHash ?? null,
          selection ? 'selecting' : 'done',
          selection ? attempt.oauth_token_ciphertext : null,
        ],
      )
      if (completed.length !== 1) throw new ForbiddenException('CI authorization expired before binding completed')
    })
  }

  private async response(row: Attempt, actor: Actor, installState?: string) {
    if (row.state === 'selecting') {
      const current = await this.webAttempt(actor, row.id)
      if (current!.state !== 'selecting') return this.response(current!, actor)
      if (!current!.oauth_token_ciphertext) throw new ForbiddenException('Selection credentials unavailable')
      const token = this.secrets.open(current!.oauth_token_ciphertext, this.aad(current!) + ':web-selection')
      if (this.github.isIdentityClient(current.app_client_id)) {
        const inventory = await this.github.availableAccounts(current.app_client_id, token)
        const bindings = await this.query(
          this.db,
          `SELECT app_client_id,installation_id,account_id,account_type
          FROM ci_installation_binding WHERE organization_id=$1 AND state<>'disabled'
          AND github_host='github.com' AND app_client_id=ANY($2::text[])`,
          [row.organization_id, this.github.ids],
        )
        let installationUrl: string | undefined
        if (current.web_target_ciphertext) {
          const target = this.webTarget(current)
          const url = new URL(this.github.byClientId(target.clientId).settings().installationUrl)
          url.pathname += '/permissions'
          url.searchParams.set('target_id', String(target.account.accountId))
          url.searchParams.set('target_type', target.account.accountType)
          url.searchParams.set('state', target.state)
          installationUrl = url.href
        }
        return {
          id: row.id,
          status: installationUrl ? 'installation_required' : 'selection_required',
          expires_at: current.expires_at.toISOString(),
          installation_url: installationUrl,
          authenticated_account: inventory.user.accountLogin,
          authorization_settings_url: this.github.identity().webSettings().authorizationSettingsUrl,
          accounts: inventory.accounts.map((account) => ({
            account_id: account.accountId,
            github_account: account.accountLogin,
            account_type: account.accountType,
            installation_id: account.installationId,
            installation_settings_url: account.installationId
              ? installationSettingsUrl({ ...account, installationId: account.installationId })
              : undefined,
            installed: account.installationId !== null,
            connected: bindings.some(
              (binding) =>
                binding.app_client_id === account.clientId &&
                Number(binding.installation_id) === account.installationId &&
                Number(binding.account_id) === account.accountId &&
                binding.account_type === account.accountType,
            ),
          })),
        }
      }
      const app = this.github.byClientId(current!.app_client_id)
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
        'SELECT id,state,account_login,allow_private FROM ci_installation_binding WHERE id=$1 AND organization_id=$2',
        [row.binding_id, row.organization_id],
      )
      if (!binding) throw new NotFoundException('CI binding unavailable')
      return {
        id: row.id,
        status: 'connected',
        binding_id: binding.id,
        listener_status: binding.state,
        github_account: binding.account_login,
        runs_on: 'boxlite',
        allow_private_repositories: binding.allow_private,
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
