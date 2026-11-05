/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { EntityManager } from 'typeorm'
import {
  CapacityPolicy,
  CapacityProvider,
  CapacityRequest,
  decodeScope,
  ExecutionJournal,
  ListenerState,
  StateCorrupt,
  StateRecord,
} from '@boxlite-ai/ci-listener'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { BOX_CREATION_LIMIT_EXCLUDED_STATES } from '../box/repositories/box.repository'
import { assertCiKeyFresh, CiActor, lockCiAuthority } from './ci-authorization'
import { CiNativeState } from './ci-native-state'

const bootstrapKey = 'quota/bootstrap'
const keyFor = (organization: string) => 'quota/' + organization
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const maximum = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
const effective = (configured: number | null, commerce: number | undefined): number | null =>
  configured === null ? (commerce ?? null) : commerce === undefined ? configured : Math.min(configured, commerce)

/** Account policy only: connected installations never receive separate hosted budgets. */
@Injectable()
export class CiSettingsService implements CapacityProvider {
  constructor(
    private readonly native: CiNativeState,
    private readonly commerce: CommerceBoxLimitService,
  ) {}

  async initialize(): Promise<void> {
    if (!this.native.app) return
    await this.native.transaction(async (tx, state) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        this.native.namespace + ':quota-bootstrap',
      ])
      await this.native.root(state)
      const [root] = await tx.query('SELECT * FROM ci_listener_state WHERE namespace=$1 AND record_key=$2 FOR UPDATE', [
        this.native.namespace,
        'backend/native',
      ])
      const [marker] = await state.read([bootstrapKey])
      if (root.payload.quotaVersion === 1) {
        this.marker(marker)
        return
      }
      if (root.payload.quotaVersion !== undefined || marker) throw new StateCorrupt()
      // One-time activation for current-format bindings; subsequent missing roots are corruption.
      await tx.query(
        `INSERT INTO ci_listener_state(namespace,record_key,record_version,schema_version,payload)
        SELECT $1,'quota/'||organization_id::text,gen_random_uuid(),1,
          jsonb_build_object('organization',organization_id::text,'maximum',NULL)
        FROM (SELECT DISTINCT organization_id FROM ci_installation_binding
          WHERE github_host='github.com' AND app_client_id=ANY($2::text[])) AS bindings
        ON CONFLICT(namespace,record_key) DO NOTHING`,
        [this.native.namespace, this.native.apps],
      )
      await this.insert(tx, bootstrapKey, { app: this.native.app, version: 1 })
      await tx.query(
        `UPDATE ci_listener_state SET payload=payload||'{"quotaVersion":1}'::jsonb,
        record_version=$3,updated_at=clock_timestamp() WHERE namespace=$1 AND record_key=$2`,
        [this.native.namespace, 'backend/native', randomUUID()],
      )
    })
  }

  /** Caller has locked the current owner/binding authority in this transaction. */
  async ensure(tx: EntityManager, organization: string): Promise<void> {
    const state = this.native.inside(tx)
    await this.initialized(state)
    await tx.query(
      `INSERT INTO ci_listener_state(namespace,record_key,record_version,schema_version,payload)
      SELECT $1,$2,$3,1,$4::jsonb WHERE NOT EXISTS
        (SELECT 1 FROM ci_installation_binding WHERE organization_id=$5
          AND github_host='github.com' AND app_client_id=ANY($6::text[]))
      ON CONFLICT(namespace,record_key) DO NOTHING`,
      [
        this.native.namespace,
        keyFor(organization),
        randomUUID(),
        JSON.stringify({ organization, maximum: null }),
        organization,
        this.native.apps,
      ],
    )
    this.policy((await state.read([keyFor(organization)]))[0], organization)
  }

  async get(actor: CiActor) {
    const captured = this.actor(actor)
    const value = await this.native.transaction(async (tx, state) => {
      await lockCiAuthority(tx, captured)
      if (!this.native.app) {
        await assertCiKeyFresh(tx, captured)
        return { available: false, max_concurrent_jobs: null, connections: [] }
      }
      await this.initialized(state)
      const [record] = await state.read([keyFor(captured.organizationId)])
      const connections = await this.connections(tx, captured.organizationId)
      if (!record && connections.length) throw new StateCorrupt()
      const configured = record ? this.policy(record, captured.organizationId) : null
      await assertCiKeyFresh(tx, captured)
      return { available: true, max_concurrent_jobs: configured, connections }
    })
    const commerce = await this.commerce.resolveMaxCreatedBoxes(captured.organizationId)
    return {
      ...value,
      commerce_limit: commerce ?? null,
      effective_limit: effective(value.max_concurrent_jobs, commerce),
    }
  }

  async update(actor: CiActor, configured: number | null) {
    const captured = this.actor(actor)
    if (!this.native.app) throw new ServiceUnavailableException('Hosted CI is not configured')
    if (!maximum(configured)) throw new BadRequestException('CI limit must be null or a nonnegative safe integer')
    const commerce = await this.commerce.resolveMaxCreatedBoxes(captured.organizationId)
    if (configured !== null && commerce !== undefined && configured > commerce)
      throw new BadRequestException('CI limit exceeds the current account allowance')
    return this.native.transaction(async (tx) => {
      await lockCiAuthority(tx, captured)
      await this.ensure(tx, captured.organizationId)
      await tx.query('SELECT record_key FROM ci_listener_state WHERE namespace=$1 AND record_key=$2 FOR UPDATE', [
        this.native.namespace,
        keyFor(captured.organizationId),
      ])
      await tx.query(
        `UPDATE ci_listener_state SET payload=$3::jsonb,record_version=$4,updated_at=clock_timestamp()
        WHERE namespace=$1 AND record_key=$2`,
        [
          this.native.namespace,
          keyFor(captured.organizationId),
          JSON.stringify({ organization: captured.organizationId, maximum: configured }),
          randomUUID(),
        ],
      )
      const connections = await this.connections(tx, captured.organizationId)
      await assertCiKeyFresh(tx, captured)
      return {
        available: true,
        max_concurrent_jobs: configured,
        commerce_limit: commerce ?? null,
        effective_limit: effective(configured, commerce),
        connections,
      }
    })
  }

  async resolve({ scope, lease, signal }: CapacityRequest): Promise<CapacityPolicy> {
    const original = decodeScope(scope),
      owner = { ...lease }
    signal.throwIfAborted()
    const commerce = await this.commerce.resolveMaxCreatedBoxes(original.organization)
    signal.throwIfAborted()
    return this.native.transaction(async (tx, state) => {
      await new ExecutionJournal(state).load(owner)
      await this.native.admit(tx, original)
      const marker = await this.initialized(state)
      const [record] = await state.read([keyFor(original.organization)])
      const configured = this.policy(record, original.organization)
      let limit = effective(configured, commerce)
      if (commerce !== undefined && limit !== 0) {
        const [count] = await tx.query(
          'SELECT count(*)::text AS used FROM box WHERE "organizationId"=$1 AND state::text <> ALL($2::text[])',
          [original.organization, BOX_CREATION_LIMIT_EXCLUDED_STATES],
        )
        const used = Number(count?.used)
        if (!Number.isSafeInteger(used) || used < 0) throw new StateCorrupt()
        if (used >= commerce) limit = 0
      }
      signal.throwIfAborted()
      return {
        limits: [{ maximum: limit, includes: (worker) => worker.organization === original.organization }],
        checks: [record, marker].map((row) => ({ key: row.key, version: row.version })),
      }
    })
  }

  private async initialized(state: ListenerState): Promise<StateRecord> {
    await this.native.root(state)
    const rows = await state.read(['backend/native', bootstrapKey])
    if ((rows.find((row) => row.key === 'backend/native')?.payload as { quotaVersion?: number })?.quotaVersion !== 1)
      throw new StateCorrupt()
    const marker = rows.find((row) => row.key === bootstrapKey)
    this.marker(marker)
    return marker!
  }
  private marker(record?: StateRecord): void {
    if (
      !record ||
      record.schema !== 1 ||
      !object(record.payload) ||
      record.payload.app !== this.native.app ||
      record.payload.version !== 1
    )
      throw new StateCorrupt()
  }
  private policy(record: StateRecord | undefined, organization: string): number | null {
    if (
      !record ||
      record.schema !== 1 ||
      !object(record.payload) ||
      record.payload.organization !== organization ||
      !maximum(record.payload.maximum)
    )
      throw new StateCorrupt()
    return record.payload.maximum
  }
  private async insert(tx: EntityManager, key: string, payload: object): Promise<void> {
    await tx.query(
      `INSERT INTO ci_listener_state(namespace,record_key,record_version,schema_version,payload)
      VALUES($1,$2,$3,1,$4::jsonb) ON CONFLICT(namespace,record_key) DO NOTHING`,
      [this.native.namespace, key, randomUUID(), JSON.stringify(payload)],
    )
  }
  private connections(tx: EntityManager, organization: string) {
    return tx.query(
      `SELECT id AS binding_id,account_login AS github_account,account_type,state AS listener_status,
      allow_public AS allow_public_repositories FROM ci_installation_binding
      WHERE organization_id=$1 AND github_host='github.com' AND app_client_id=ANY($2::text[]) ORDER BY account_login,id`,
      [organization, this.native.apps],
    )
  }
  private actor(actor: CiActor): CiActor {
    if (!actor.organizationId || !actor.userId) throw new BadRequestException('Original organization actor required')
    return {
      organizationId: actor.organizationId,
      userId: actor.userId,
      apiKey: actor.apiKey ? { keyHash: actor.apiKey.keyHash } : undefined,
    }
  }
}
