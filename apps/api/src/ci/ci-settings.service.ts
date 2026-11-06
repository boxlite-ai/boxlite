/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { EntityManager } from 'typeorm'
import {
  CapacityPolicy,
  CapacityProvider,
  CapacityRequest,
  decodeScope,
  decodeAllocation,
  scopeKey,
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

  /** Aggregate-only read; the controller authorizes organization resource access. */
  async capacity(organization: string) {
    if (!this.native.app)
      return { available: false, used: 0, max_concurrent_jobs: null, commerce_limit: null, effective_limit: null }
    const commerce = await this.commerce.resolveMaxCreatedBoxes(organization)
    return this.native.transaction(async (tx, state) => {
      // Dashboard reads must neither borrow the leader lease nor mix graph versions.
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
      await this.initialized(state)
      const [record] = await state.read([keyFor(organization)])
      const configured = record ? this.policy(record, organization) : null
      const used = await this.occupied(tx, state, organization)
      if (!record) {
        const [binding] = await tx.query(
          `SELECT id FROM ci_installation_binding WHERE organization_id=$1 AND app_client_id=ANY($2::text[]) LIMIT 1`,
          [organization, this.native.apps],
        )
        if (binding || used) throw new StateCorrupt()
      }
      return {
        available: true,
        used,
        max_concurrent_jobs: configured,
        commerce_limit: commerce ?? null,
        effective_limit: effective(configured, commerce),
      }
    })
  }

  private async occupied(tx: EntityManager, state: ListenerState, organization: string): Promise<number> {
    const [catalog] = await state.read(['catalog/scopes'])
    const keys = object(catalog?.payload) ? catalog.payload.keys : undefined
    if (
      catalog?.schema !== 1 ||
      !Array.isArray(keys) ||
      keys.length > 10000 ||
      keys.some((key) => typeof key !== 'string' || !/^scope\/[a-f0-9]{64}$/.test(key)) ||
      new Set(keys).size !== keys.length
    )
      throw new StateCorrupt()
    const rows = await tx.query(
      `SELECT refs.key AS scope_key,s.schema_version AS scope_schema,s.payload AS scope_payload,
        active.key AS worker_key,w.schema_version AS worker_schema,w.payload AS worker_payload
      FROM unnest($2::text[]) AS refs(key)
      LEFT JOIN ci_listener_state s ON s.namespace=$1 AND s.record_key=refs.key
      LEFT JOIN LATERAL jsonb_array_elements_text(s.payload->'active') AS active(key) ON true
      LEFT JOIN ci_listener_state w ON w.namespace=$1 AND w.record_key=active.key
      WHERE s.payload->'scope'->>'organization'=$3 OR s.payload->'scope'->>'organization' IS NULL LIMIT 100001`,
      [this.native.namespace, keys, organization],
    )
    if (rows.length > 100000) throw new StateCorrupt()
    const scopes = new Set<string>(),
      workers = new Set<string>()
    let used = 0
    for (const row of rows) {
      if (!scopes.has(row.scope_key)) {
        const payload = row.scope_payload
        if (
          row.scope_schema !== 1 ||
          !object(payload) ||
          !Array.isArray(payload.active) ||
          payload.active.length > 10000 ||
          payload.active.some((key) => typeof key !== 'string' || !/^worker\/[a-f0-9]{32}$/.test(key)) ||
          new Set(payload.active).size !== payload.active.length ||
          scopeKey(decodeScope(payload.scope)) !== row.scope_key
        )
          throw new StateCorrupt()
        scopes.add(row.scope_key)
      }
      if (row.worker_key === null) continue
      if (row.worker_schema !== 1 || workers.has(row.worker_key)) throw new StateCorrupt()
      const allocation = decodeAllocation(row.worker_payload)
      if (allocation.scope !== row.scope_key || row.worker_key !== 'worker/' + allocation.name.slice(7))
        throw new StateCorrupt()
      workers.add(row.worker_key)
      if (allocation.box.phase !== 'absent') used++
    }
    return used
  }

  async updateConnection(actor: CiActor, id: string, allowPublic: boolean): Promise<void> {
    const captured = this.actor(actor)
    if (typeof allowPublic !== 'boolean') throw new BadRequestException('Explicit public repository policy required')
    await this.native.transaction(async (tx, state) => {
      await lockCiAuthority(tx, captured)
      await this.native.root(state)
      const [binding] = await tx.query(
        `SELECT state,allow_public,app_client_id,installation_id,account_id FROM ci_installation_binding WHERE id=$1 AND organization_id=$2
        AND github_host='github.com' AND app_client_id=ANY($3::text[]) FOR UPDATE`,
        [id, captured.organizationId, this.native.apps],
      )
      if (!binding) throw new NotFoundException('CI connection not found')
      if (binding.state === 'disabled')
        throw new ConflictException('Reconnect this disabled CI connection before updating it')
      if (binding.allow_public !== allowPublic) {
        // New work uses a fresh catalog; historical scopes retain original cleanup identities.
        await tx.query(
          `UPDATE ci_installation_binding SET allow_public=$3,generation=generation+1,state='provisioning'
          WHERE id=$1 AND organization_id=$2`,
          [id, captured.organizationId, allowPublic],
        )
        await this.native.wakeInventory(tx, binding.app_client_id, {
          installationId: Number(binding.installation_id),
          accountId: Number(binding.account_id),
        })
      }
      await assertCiKeyFresh(tx, captured)
    })
  }

  async deleteConnection(actor: CiActor, id: string): Promise<void> {
    const captured = this.actor(actor)
    await this.native.transaction(async (tx) => {
      await lockCiAuthority(tx, captured)
      const [binding] = await tx.query(
        `SELECT app_client_id FROM ci_installation_binding WHERE id=$1 AND organization_id=$2
        AND github_host='github.com' AND app_client_id=ANY($3::text[])`,
        [id, captured.organizationId, this.native.apps],
      )
      if (!binding) throw new NotFoundException('CI connection not found')
      // Finalization locks its attempt before its binding; keep that ordering here.
      await tx.query(
        `WITH pending AS (SELECT id FROM ci_connect_attempt WHERE organization_id=$1 AND app_client_id=$2
          AND state IN ('pending','polling','selecting','installation_required') ORDER BY id FOR UPDATE)
        UPDATE ci_connect_attempt SET state='cancelled',device_ciphertext=NULL,oauth_verifier_ciphertext=NULL,
          oauth_token_ciphertext=NULL,lease_id=NULL,lease_until=NULL WHERE id IN (SELECT id FROM pending)`,
        [captured.organizationId, binding.app_client_id],
      )
      await tx.query(
        `UPDATE ci_installation_binding SET state='disabled',
          generation=CASE WHEN state='disabled' THEN generation ELSE generation+1 END
        WHERE id=$1 AND organization_id=$2`,
        [id, captured.organizationId],
      )
      await assertCiKeyFresh(tx, captured)
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
      WHERE organization_id=$1 AND github_host='github.com' AND app_client_id=ANY($2::text[])
      AND state<>'disabled' ORDER BY account_login,id`,
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
