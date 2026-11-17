/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { EntityManager } from 'typeorm'
import { AuditLog } from '../audit/entities/audit-log.entity'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { CiAdministrator, lockCiAdministrator } from './ci-authorization'
import { CiAdminCreate, CiAdminLookup, CiAdminPage, CiAdminUpdate, CiAdminVersion } from './ci-admin.dto'
import { CiNativeState } from './ci-native-state'
import { CiSettingsService } from './ci-settings.service'

type Binding = {
  id: string
  organization_id: string
  organization_name: string
  app_client_id: string
  installation_id: string
  account_id: string
  account_login: string
  account_type: 'User' | 'Organization'
  state: string
  admin_managed: boolean
  allow_private: boolean
  generation: string
}
const selection = `SELECT b.*,o.name AS organization_name FROM ci_installation_binding b
  JOIN organization o ON o.id=b.organization_id`
const view = (b: Binding) => ({
  binding_id: b.id,
  organization_id: b.organization_id,
  organization_name: b.organization_name,
  app_client_id: b.app_client_id,
  installation_id: b.installation_id,
  github_account_id: b.account_id,
  github_account: b.account_login,
  account_type: b.account_type,
  listener_status: b.state,
  admin_managed: b.admin_managed,
  allow_private_repositories: b.allow_private,
  generation: b.generation,
})

@Injectable()
export class CiAdminService {
  constructor(
    private readonly native: CiNativeState,
    private readonly settings: CiSettingsService,
  ) {}

  list(actor: CiAdministrator, organization: string, page: CiAdminPage) {
    return this.authorized(actor, async (tx) => {
      await this.target(tx, organization, false)
      return this.page(tx, 'b.organization_id=$1', [organization], page)
    })
  }
  lookup(actor: CiAdministrator, query: CiAdminLookup) {
    if (!!query.github_account === !!query.github_account_id)
      throw new BadRequestException('Supply exactly one GitHub account login or ID')
    const filter = query.github_account ? 'lower(b.account_login)=$2' : 'b.account_id=$2'
    return this.authorized(actor, (tx) =>
      this.page(
        tx,
        `b.github_host='github.com' AND b.account_type=$1 AND ${filter}`,
        [query.account_type, query.github_account?.toLowerCase() ?? query.github_account_id],
        query,
      ),
    )
  }
  async create(actor: CiAdministrator, organization: string, input: CiAdminCreate) {
    const captured = this.actor(actor),
      body = { ...input }
    if (
      body.force
        ? !body.expected_binding_id || !body.expected_generation
        : body.expected_binding_id || body.expected_generation
    )
      throw new BadRequestException(
        'force requires expected_binding_id and expected_generation; omit both for creation',
      )
    await this.authorized(captured, (tx) => this.target(tx, organization, true))
    const app = this.native.registry.forType(body.account_type)
    const installed = await app.verifyInstalledAccount(body.github_account)
    return this.authorized(captured, async (tx) => {
      await this.target(tx, organization, true)
      // First-time target quota must exist before a binding moves into that organization.
      await this.settings.ensure(tx, organization)
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [this.native.namespace + ':bindings'])
      const identity = [installed.accountType, installed.accountId]
      const active: Binding[] = await tx.query(
        `${selection} WHERE b.github_host='github.com'
        AND b.account_type=$1 AND b.account_id=$2 AND b.state<>'disabled' ORDER BY b.id LIMIT 2 FOR UPDATE OF b`,
        identity,
      )
      if (active.length > 1)
        throw new ConflictException({
          message: 'Multiple active connections require explicit cleanup',
          connections: active.map(view),
        })
      let before: Binding | undefined
      if (body.force) {
        ;[before] = await tx.query(
          `${selection} WHERE b.github_host='github.com' AND b.account_type=$1
          AND b.account_id=$2 AND b.id=$3 FOR UPDATE OF b`,
          [...identity, body.expected_binding_id],
        )
        if (!before || before.generation !== body.expected_generation || (active[0] && active[0].id !== before.id))
          throw new ConflictException({
            message: 'Connection changed; repeat the account lookup',
            connections: active.map(view),
          })
      } else {
        const [retained] = active.length
          ? active
          : await tx.query(
              `${selection} WHERE b.github_host='github.com'
          AND b.account_type=$1 AND b.account_id=$2 ORDER BY b.id LIMIT 1`,
              identity,
            )
        if (retained) this.conflict(retained)
      }
      const [claimed]: Binding[] = await tx.query(
        `${selection} WHERE b.github_host='github.com'
        AND b.app_client_id=$1 AND b.installation_id=$2 FOR UPDATE OF b`,
        [app.clientId, installed.installationId],
      )
      if (claimed && claimed.id !== before?.id) this.conflict(claimed)
      let id = before?.id ?? randomUUID()
      if (
        before &&
        before.app_client_id === app.clientId &&
        Number(before.installation_id) === installed.installationId
      ) {
        await tx.query(
          `UPDATE ci_installation_binding SET organization_id=$2,actor_id=$3,admin_managed=true,
          allow_private=$4,account_login=$5,state='provisioning',generation=generation+1 WHERE id=$1`,
          [id, organization, captured.userId, body.allow_private_repositories, installed.accountLogin],
        )
      } else {
        if (before) {
          await tx.query("UPDATE ci_installation_binding SET state='disabled',generation=generation+1 WHERE id=$1", [
            before.id,
          ])
          id = randomUUID()
        }
        await tx.query(
          `INSERT INTO ci_installation_binding
          (id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation,allow_private,admin_managed)
          VALUES($1,'github.com',$2,$3,$4,$5,$6,$7,$8,true,$9,true)`,
          [
            id,
            app.clientId,
            installed.installationId,
            installed.accountId,
            installed.accountLogin,
            installed.accountType,
            organization,
            captured.userId,
            body.allow_private_repositories,
          ],
        )
      }
      const [{ count }] = await tx.query(
        `SELECT count(*)::int AS count FROM ci_installation_binding
        WHERE github_host='github.com' AND app_client_id=ANY($1::text[]) AND state IN ('provisioning','ready')`,
        [this.native.apps],
      )
      if (count > 10000) throw new ServiceUnavailableException('CI binding capacity exceeded')
      await this.native.wakeInventory(tx, app.clientId, installed)
      const after = await this.binding(tx, organization, id)
      await this.audit(tx, captured, before ? 'update' : 'create', before, after)
      return { created: !before, connection: view(after) }
    })
  }
  update(actor: CiAdministrator, organization: string, id: string, body: CiAdminUpdate) {
    const captured = this.actor(actor),
      input = { ...body }
    return this.authorized(captured, async (tx) => {
      await this.target(tx, organization, true)
      const before = await this.binding(tx, organization, id, true)
      this.version(before, input)
      if (before.state === 'disabled')
        throw new ConflictException('Reconnect this disabled CI connection before updating it')
      if (before.allow_private !== input.allow_private_repositories) {
        await tx.query(
          `UPDATE ci_installation_binding SET allow_private=$2,state='provisioning',generation=generation+1 WHERE id=$1`,
          [id, input.allow_private_repositories],
        )
        await this.native.wakeInventory(tx, before.app_client_id, {
          installationId: Number(before.installation_id),
          accountId: Number(before.account_id),
        })
      }
      const after = await this.binding(tx, organization, id)
      await this.audit(tx, captured, 'update', before, after)
      return view(after)
    })
  }
  remove(actor: CiAdministrator, organization: string, id: string, body: CiAdminVersion) {
    const captured = this.actor(actor),
      expected = { ...body }
    return this.authorized(captured, async (tx) => {
      const before = await this.binding(tx, organization, id)
      this.version(before, expected)
      // Browser finalization locks its attempt before its binding; preserve that ordering.
      await tx.query(
        `WITH pending AS (SELECT id FROM ci_connect_attempt WHERE organization_id=$1
        AND (app_client_id=$2 OR flow='web') AND state IN ('pending','polling','selecting','installation_required') ORDER BY id FOR UPDATE)
        UPDATE ci_connect_attempt SET state='cancelled',device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,
        oauth_token_ciphertext=NULL,web_target_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id IN (SELECT id FROM pending)`,
        [organization, before.app_client_id],
      )
      const [, affected] = await tx.query(
        `UPDATE ci_installation_binding SET state='disabled',
        generation=CASE WHEN state='disabled' THEN generation ELSE generation+1 END
        WHERE id=$1 AND organization_id=$2 AND generation=$3 RETURNING id`,
        [id, organization, expected.expected_generation],
      )
      if (affected !== 1) throw new ConflictException('Connection changed; repeat the account lookup')
      await this.audit(tx, captured, 'delete', before, await this.binding(tx, organization, id))
    })
  }
  private async page(tx: EntityManager, filter: string, parameters: unknown[], page: CiAdminPage) {
    const values = [...parameters]
    if (page.cursor) {
      values.push(page.cursor)
      filter += ` AND b.id>$${values.length}::uuid`
    }
    values.push(page.limit + 1)
    const rows: Binding[] = await tx.query(`${selection} WHERE ${filter} ORDER BY b.id LIMIT $${values.length}`, values)
    const items = rows.slice(0, page.limit).map(view)
    return { items, next_cursor: rows.length > page.limit ? items[items.length - 1].binding_id : null }
  }
  private async binding(tx: EntityManager, organization: string, id: string, lock = false): Promise<Binding> {
    const [binding] = await tx.query(
      `${selection} WHERE b.organization_id=$1 AND b.id=$2${lock ? ' FOR UPDATE OF b' : ''}`,
      [organization, id],
    )
    if (!binding) throw new NotFoundException('CI connection not found')
    return binding
  }
  private async target(tx: EntityManager, id: string, writable: boolean): Promise<void> {
    const [org] = await tx.query(
      `SELECT suspended AND ("suspendedUntil" IS NULL OR "suspendedUntil">clock_timestamp()) AS suspended
      FROM organization WHERE id=$1 FOR SHARE`,
      [id],
    )
    if (!org) throw new NotFoundException('Organization not found')
    if (writable && org.suspended) throw new ForbiddenException('Target organization is suspended')
  }
  private version(binding: Binding, input: CiAdminVersion) {
    if (binding.generation !== input.expected_generation) this.conflict(binding)
  }
  private conflict(binding: Binding): never {
    throw new ConflictException({
      message: 'Connection exists or changed; repeat the account lookup',
      connection: view(binding),
    })
  }
  private actor(actor: CiAdministrator): CiAdministrator {
    return {
      userId: actor.userId,
      email: actor.email,
      apiKey: actor.apiKey ? { keyHash: actor.apiKey.keyHash } : undefined,
    }
  }
  private authorized<T>(actor: CiAdministrator, work: (tx: EntityManager) => Promise<T>): Promise<T> {
    const captured = this.actor(actor)
    return this.native.transaction(async (tx) => {
      await lockCiAdministrator(tx, captured)
      const result = await work(tx)
      await lockCiAdministrator(tx, captured)
      return result
    })
  }
  private async audit(
    tx: EntityManager,
    actor: CiAdministrator,
    action: string,
    before: Binding | undefined,
    after: Binding,
  ) {
    await tx.save(
      new AuditLog({
        id: randomUUID(),
        actorId: actor.userId,
        actorEmail: actor.email || '',
        organizationId: after.organization_id,
        action,
        targetType: AuditTarget.CI_CONNECTION,
        targetId: after.id,
        statusCode: action === 'create' ? 201 : action === 'delete' ? 204 : 200,
        metadata: { before: before ? view(before) : null, after: view(after) },
      }),
    )
  }
}
