import { AsyncLocalStorage } from 'node:async_hooks'
import type { DataSource, EntityManager } from 'typeorm'
import type { Spec } from './spec'
const TABLES = new Set([
  'apps',
  'envs',
  'box_tokens',
  'spec_versions',
  'deployments',
  'deployment_events',
  'uploads',
  'snapshots',
  'logs',
  'activity',
  'db_snapshots',
  'schedule_runs',
  'app_users',
  'app_sessions',
  'open_tickets',
  'auth_handoffs',
  'env_volumes',
  'db_readers',
  'console_access',
  'feedback',
  'org_secrets',
  'app_oauth_clients',
  'app_secrets',
  'app_email_senders',
  'auth_email_codes',
  'app_notes',
  'finding_acks',
  'supervisor_status',
  'previews',
])
const JSON_COLUMNS = new Set(['spec', 'steps', 'changes', 'error', 'request', 'manifest', 'services', 'detail', 'data'])
function prepareSql(sql: string, schema: string): string {
  let parameter = 0
  const ignored = /^\s*INSERT OR IGNORE\b/i.test(sql)
  let out = sql.replace(/INSERT OR IGNORE/i, 'INSERT').replace(/\?/g, () => '$' + ++parameter)
  out = out.replace(/\b(FROM|JOIN|INTO|UPDATE)\s+("?)([a-z_]+)\2/gi, (match, keyword, _quote, table) =>
    TABLES.has(table) ? keyword + ' ' + schema + '.' + table : match,
  )
  if (ignored) out += ' ON CONFLICT DO NOTHING'
  return out
}
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'string' && /^(id|n|count|active_sessions)$/.test(key) && /^\d+$/.test(value)
          ? Number(value)
          : JSON_COLUMNS.has(key) && value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value,
    ]),
  )
}
export const LOG_RING_SIZE = 20_000

export interface AppRow {
  id: string
  name: string
  created_at: string
  neon_project_id: string | null
  neon_main_branch_id: string | null
  deleted_at?: string | null
  purge_after?: string | null
  /** The platform organization that owns this App. */
  org_id: string
}

export interface EnvRow {
  id: string
  app_id: string
  name: string
  created_at: string
  from_env: string | null
  with_data: number
  neon_branch_id: string | null
  db_url: string | null
  box_id: string | null
  box_url: string | null
  box_image: string | null
  box_size: string | null
  box_volumes: string | null
  /** The forwarding secret: X-BoxLite-Gateway on proxied end-user traffic only (supervisor.ts forwardHeaders). */
  forward_secret: string
  /** X-BoxLite-Control on the CP's own /.boxlite/sv/* calls only (supervisor.ts controlHeaders). */
  control_secret: string
  access_override: string | null
  next_deployment: number
  live_deployment: number | null
  requested_deployment: number | null
  services: string | null
  services_at: string | null
  /** Stable public origin assigned by the platform Domain service. */
  public_url?: string | null
}

export type DeploymentKind = 'deploy' | 'apply' | 'rollback'
export type DeploymentStatus =
  | 'queued'
  | 'uploading'
  | 'building'
  | 'migrating'
  | 'starting'
  | 'live'
  | 'failed'
  | 'cancelled'
  | 'superseded'
  | 'rolled_back'

export const ACTIVE_STATUSES: DeploymentStatus[] = ['queued', 'uploading', 'building', 'migrating', 'starting']

export interface Step {
  name: string
  status: 'running' | 'done' | 'failed' | 'skipped'
  ms?: number
  /** Human detail the CLI prints as-is. */
  detail?: string
}

export interface Change {
  kind: '+' | '~' | '-' | 'online_only'
  path: string
  from?: unknown
  to?: unknown
}

export interface MigrationFile {
  file: string
  sha256: string
  sql: string
}

/** What the CLI asked for, persisted so the orchestrator (and a restarted CP) can run it later. */
export interface DeploymentRequest {
  kind: DeploymentKind
  manifest?: import('@boxlite-ai/cloud-app-shared').Manifest
  migrations?: MigrationFile[]
  /** Migration files (without SQL) the job actually used, for GET /db/migrations. */
  resolved_migrations?: { file: string; sha256: string }[]
  force?: boolean
  to?: number
  with_database?: boolean
}

export interface DeploymentError {
  step: string
  message: string
  log_tail?: string[]
}

export interface Deployment {
  env_id: string
  number: number
  kind: DeploymentKind
  status: DeploymentStatus
  message: string | null
  by: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  spec_version: number | null
  base_version: number | null
  snapshot_id: string | null
  steps: Step[]
  changes: Change[]
  error: DeploymentError | null
  request: DeploymentRequest
  idempotency_key: string | null
  release: number | null
  box_id: string | null
  built: boolean
  restore_point: string | null
  live_at: string | null
  cancel_requested?: boolean
}

export interface SnapshotFile {
  path: string
  size: number
  mode: number
  sha256: string
}

export interface LogLine {
  id?: number
  ts: string
  source: string
  level: string
  line: string
  deployment?: number | null
}

export type SQLInputValue = string | number | bigint | boolean | Buffer | null
type Row = Record<string, SQLInputValue>

export const now = (): string => new Date().toISOString()

export interface SecretCipher {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}
const SECRET_COLUMNS: Record<string, readonly string[]> = {
  envs: ['db_url', 'forward_secret', 'control_secret'],
  app_secrets: ['value'],
  org_secrets: ['value'],
  db_readers: ['password'],
  app_oauth_clients: ['client_secret'],
  app_email_senders: ['password'],
}
const statementTable = (sql: string) => /\b(?:FROM|INTO|UPDATE)\s+(?:cloud_app\.)?([a-z_]+)/i.exec(sql)?.[1]
export class Store {
  private readonly transaction = new AsyncLocalStorage<EntityManager>()
  constructor(
    readonly dataSource: DataSource,
    readonly organizationId?: string,
    private readonly cipher?: SecretCipher,
    readonly schema = 'cloud_app',
  ) {
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Invalid App schema')
  }
  private get manager(): EntityManager {
    return this.transaction.getStore() ?? this.dataSource.manager
  }
  async get<T>(sql: string, ...params: SQLInputValue[]): Promise<T | undefined> {
    return (await this.all<T>(sql, ...params))[0]
  }
  async all<T>(sql: string, ...params: SQLInputValue[]): Promise<T[]> {
    const rows = await this.manager.query(prepareSql(sql, this.schema), params)
    const secrets = SECRET_COLUMNS[statementTable(sql) ?? ''] ?? []
    return Promise.all(
      rows.map(async (row: Record<string, unknown>) => {
        const value = normalizeRow(row)
        if (this.cipher)
          for (const column of secrets)
            if (typeof value[column] === 'string') value[column] = await this.cipher.decrypt(value[column] as string)
        return value as T
      }),
    )
  }
  async run(sql: string, ...params: SQLInputValue[]): Promise<{ changes: number; lastInsertRowid: number }> {
    params = await this.sealParameters(sql, params)
    const statement = prepareSql(sql, this.schema)
    const raw = await this.manager.query(statement + (/\bRETURNING\b/i.test(statement) ? '' : ' RETURNING *'), params)
    const rows = Array.isArray(raw?.[0]) ? raw[0] : raw
    return {
      changes: Array.isArray(raw?.[0]) ? Number(raw[1]) : rows.length,
      lastInsertRowid: Number(rows[0]?.id ?? 0),
    }
  }
  private async sealParameters(sql: string, params: SQLInputValue[]): Promise<SQLInputValue[]> {
    const table = statementTable(sql),
      columns = SECRET_COLUMNS[table ?? '']
    if (!this.cipher || !columns) return params
    const values = [...params]
    const insert = /^\s*INSERT(?: OR IGNORE)? INTO \w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(sql)
    const update = /^\s*UPDATE \w+ SET ([\s\S]+?) WHERE /i.exec(sql)
    const assignments = insert
      ? insert[1].split(',').map((column, index) => ({ column: column.trim(), value: insert[2].split(',')[index] }))
      : update
        ? update[1]
            .split(',')
            .map((entry) => ({ column: entry.split('=')[0].trim(), value: entry.split('=').slice(1).join('=') }))
        : []
    if (/^\s*(?:INSERT|UPDATE)\b/i.test(sql) && !assignments.length)
      throw new Error('Unsupported secret mutation for ' + table)
    let parameter = 0
    for (const assignment of assignments) {
      const count = (assignment.value.match(/\?/g) ?? []).length
      if (columns.includes(assignment.column) && count) {
        if (count !== 1) throw new Error('Secret mutation must assign one parameter')
        if (typeof values[parameter] === 'string')
          values[parameter] = await this.cipher.encrypt(values[parameter] as string)
      }
      parameter += count
    }
    return values
  }
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.transaction.getStore()) return fn()
    return this.dataSource.transaction((manager) => this.transaction.run(manager, fn))
  }
  // ---- apps / envs -------------------------------------------------------

  async appByName(name: string): Promise<AppRow | undefined> {
    return await this.get<AppRow>(
      'SELECT * FROM apps WHERE name = ? AND deleted_at IS NULL AND (?::uuid IS NULL OR org_id = ?::uuid)',
      name,
      this.organizationId ?? null,
      this.organizationId ?? null,
    )
  }

  /** Includes soft-deleted Apps; only lifecycle code and the proxy's "app deleted" page use it. */
  async appByNameAnyState(name: string): Promise<AppRow | undefined> {
    return await this.get<AppRow>(
      'SELECT * FROM apps WHERE name = ? AND (?::uuid IS NULL OR org_id = ?::uuid)',
      name,
      this.organizationId ?? null,
      this.organizationId ?? null,
    )
  }

  /** Live Apps, newest first. */
  async apps(): Promise<AppRow[]> {
    return await this.all<AppRow>(
      'SELECT * FROM apps WHERE deleted_at IS NULL AND (?::uuid IS NULL OR org_id = ?::uuid) ORDER BY created_at DESC',
      this.organizationId ?? null,
      this.organizationId ?? null,
    )
  }

  /** Soft-deleted Apps (PRD 3.13), most recently deleted first. */
  async deletedApps(): Promise<AppRow[]> {
    return await this.all<AppRow>(
      'SELECT * FROM apps WHERE deleted_at IS NOT NULL AND (?::uuid IS NULL OR org_id = ?::uuid) ORDER BY deleted_at DESC',
      this.organizationId ?? null,
      this.organizationId ?? null,
    )
  }

  async appById(id: string): Promise<AppRow | undefined> {
    return await this.get<AppRow>(
      'SELECT * FROM apps WHERE id = ? AND (?::uuid IS NULL OR org_id = ?::uuid)',
      id,
      this.organizationId ?? null,
      this.organizationId ?? null,
    )
  }

  async envByName(appId: string, name: string): Promise<EnvRow | undefined> {
    return await this.get<EnvRow>('SELECT * FROM envs WHERE app_id = ? AND name = ?', appId, name)
  }

  async envById(id: string): Promise<EnvRow | undefined> {
    return await this.get<EnvRow>('SELECT * FROM envs WHERE id = ?', id)
  }

  async envs(appId: string): Promise<EnvRow[]> {
    return await this.all<EnvRow>("SELECT * FROM envs WHERE app_id = ? ORDER BY name = 'main' DESC, created_at", appId)
  }

  async updateEnv(id: string, fields: Partial<Omit<EnvRow, 'id'>>): Promise<void> {
    const keys = Object.keys(fields)
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    await this.run(`UPDATE envs SET ${sets} WHERE id = ?`, ...keys.map((k) => (fields as Row)[k] ?? null), id)
  }

  async updateApp(id: string, fields: Partial<Omit<AppRow, 'id'>>): Promise<void> {
    const keys = Object.keys(fields)
    if (keys.length === 0) return
    const sets = keys.map((k) => `${k} = ?`).join(', ')
    await this.run(`UPDATE apps SET ${sets} WHERE id = ?`, ...keys.map((k) => (fields as Row)[k] ?? null), id)
  }

  // ---- specs -------------------------------------------------------------

  async latestSpecVersion(envId: string): Promise<number> {
    const row = await this.get<{ v: number | null }>(
      'SELECT MAX(version) AS v FROM spec_versions WHERE env_id = ?',
      envId,
    )
    return row?.v ?? 0
  }

  /**
   * The newest spec version that took effect or is still on its way: failed and cancelled
   * deployments never changed the env, so they must not make the next deploy look stale.
   */
  async effectiveSpecVersion(envId: string): Promise<number> {
    const row = await this.get<{ v: number | null }>(
      `SELECT MAX(sv.version) AS v FROM spec_versions sv
         LEFT JOIN deployments d ON d.env_id = sv.env_id AND d.number = sv.deployment
        WHERE sv.env_id = ? AND (d.status IS NULL OR d.status NOT IN ('failed', 'cancelled'))`,
      envId,
    )
    return row?.v ?? 0
  }

  async spec(envId: string, version?: number): Promise<Spec | undefined> {
    const row =
      version === undefined
        ? await this.get<{ spec: string }>(
            'SELECT spec FROM spec_versions WHERE env_id = ? ORDER BY version DESC LIMIT 1',
            envId,
          )
        : await this.get<{ spec: string }>(
            'SELECT spec FROM spec_versions WHERE env_id = ? AND version = ?',
            envId,
            version,
          )
    return row ? (JSON.parse(row.spec) as Spec) : undefined
  }

  async insertSpec(envId: string, spec: Spec): Promise<void> {
    await this.run(
      'INSERT INTO spec_versions (env_id, version, deployment, spec, created_at) VALUES (?, ?, ?, ?, ?)',
      envId,
      spec.version,
      spec.deployment,
      JSON.stringify(spec),
      now(),
    )
  }

  // ---- deployments -------------------------------------------------------

  private mapDeployment(r: Record<string, unknown>): Deployment {
    return {
      ...(r as unknown as Deployment),
      steps: JSON.parse(r.steps as string),
      changes: JSON.parse(r.changes as string),
      error: r.error ? JSON.parse(r.error as string) : null,
      request: JSON.parse(r.request as string),
      built: Boolean(r.built),
    }
  }

  async deployment(envId: string, number: number): Promise<Deployment | undefined> {
    const r = await this.get<Record<string, unknown>>(
      'SELECT * FROM deployments WHERE env_id = ? AND number = ?',
      envId,
      number,
    )
    return r ? this.mapDeployment(r) : undefined
  }

  async deploymentByIdempotencyKey(envId: string, key: string): Promise<Deployment | undefined> {
    const r = await this.get<Record<string, unknown>>(
      'SELECT * FROM deployments WHERE env_id = ? AND idempotency_key = ?',
      envId,
      key,
    )
    return r ? this.mapDeployment(r) : undefined
  }

  async deployments(envId: string, limit = 20): Promise<Deployment[]> {
    return (
      await this.all<Record<string, unknown>>(
        'SELECT * FROM deployments WHERE env_id = ? ORDER BY number DESC LIMIT ?',
        envId,
        limit,
      )
    ).map((r) => this.mapDeployment(r))
  }

  async deploymentsWhere(where: string, ...params: SQLInputValue[]): Promise<Deployment[]> {
    return (await this.all<Record<string, unknown>>(`SELECT * FROM deployments WHERE ${where}`, ...params)).map((r) =>
      this.mapDeployment(r),
    )
  }

  /** Allocates the next deployment number for the env and inserts the row, atomically. */
  async insertDeployment(d: Omit<Deployment, 'number' | 'env_id'>, envId: string): Promise<Deployment> {
    return await this.tx(async () => {
      const env = await this.get<EnvRow>('SELECT * FROM envs WHERE id = ? FOR UPDATE', envId)
      if (!env) throw new Error(`env ${envId} vanished`)
      if (d.idempotency_key) {
        const existing = await this.deploymentByIdempotencyKey(envId, d.idempotency_key)
        if (existing) return existing
      }
      const number = env.next_deployment
      await this.run('UPDATE envs SET next_deployment = ? WHERE id = ?', number + 1, envId)
      await this.run(
        `INSERT INTO deployments (env_id, number, kind, status, message, by, created_at, started_at, finished_at, spec_version,
           base_version, snapshot_id, steps, changes, error, request, idempotency_key, release, box_id, built, restore_point, live_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        envId,
        number,
        d.kind,
        d.status,
        d.message,
        d.by,
        d.created_at,
        d.started_at,
        d.finished_at,
        d.spec_version,
        d.base_version,
        d.snapshot_id,
        JSON.stringify(d.steps),
        JSON.stringify(d.changes),
        d.error ? JSON.stringify(d.error) : null,
        JSON.stringify(d.request),
        d.idempotency_key,
        d.release,
        d.box_id,
        d.built ? 1 : 0,
        d.restore_point,
        d.live_at,
      )
      return (await this.deployment(envId, number))!
    })
  }

  async updateDeployment(
    envId: string,
    number: number,
    fields: Partial<Omit<Deployment, 'env_id' | 'number'>>,
  ): Promise<Deployment> {
    const cols: string[] = []
    const vals: SQLInputValue[] = []
    for (const [k, v] of Object.entries(fields)) {
      cols.push(`${k} = ?`)
      if (k === 'steps' || k === 'changes' || k === 'request') vals.push(JSON.stringify(v))
      else if (k === 'error') vals.push(v ? JSON.stringify(v) : null)
      else if (k === 'built') vals.push(v ? 1 : 0)
      else vals.push((v ?? null) as SQLInputValue)
    }
    if (cols.length)
      await this.run(
        `UPDATE deployments SET ${cols.join(', ')} WHERE env_id = ? AND number = ?`,
        ...vals,
        envId,
        number,
      )
    return (await this.deployment(envId, number))!
  }

  // ---- deployment events -------------------------------------------------

  async insertEvent(envId: string, number: number, event: string, data: unknown): Promise<number> {
    return await this.tx(async () => {
      await this.get('SELECT number FROM deployments WHERE env_id = ? AND number = ? FOR UPDATE', envId, number)
      const row = await this.get<{ s: number | null }>(
        'SELECT MAX(seq) AS s FROM deployment_events WHERE env_id = ? AND number = ?',
        envId,
        number,
      )
      const seq = (row?.s ?? 0) + 1
      await this.run(
        'INSERT INTO deployment_events (env_id, number, seq, event, data, ts) VALUES (?, ?, ?, ?, ?, ?)',
        envId,
        number,
        seq,
        event,
        JSON.stringify(data),
        now(),
      )
      return seq
    })
  }

  async events(envId: string, number: number, afterSeq = 0): Promise<{ seq: number; event: string; data: unknown }[]> {
    return (
      await this.all<{ seq: number; event: string; data: string }>(
        'SELECT seq, event, data FROM deployment_events WHERE env_id = ? AND number = ? AND seq > ? ORDER BY seq',
        envId,
        number,
        afterSeq,
      )
    ).map((r) => ({ seq: r.seq, event: r.event, data: JSON.parse(r.data) }))
  }

  // ---- logs --------------------------------------------------------------

  /** Appends lines and trims the env's ring to LOG_RING_SIZE. */
  async appendLogs(envId: string, lines: LogLine[]): Promise<LogLine[]> {
    const out: LogLine[] = []
    await this.tx(async () => {
      for (const l of lines) {
        const r = await this.run(
          'INSERT INTO logs (env_id, ts, source, level, line, deployment) VALUES (?, ?, ?, ?, ?, ?)',
          envId,
          l.ts,
          l.source,
          l.level,
          l.line,
          l.deployment ?? null,
        )
        out.push({ ...l, id: r.lastInsertRowid })
      }
      const cut = await this.get<{ id: number }>(
        'SELECT id FROM logs WHERE env_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?',
        envId,
        LOG_RING_SIZE,
      )
      if (cut) await this.run('DELETE FROM logs WHERE env_id = ? AND id <= ?', envId, cut.id)
    })
    return out
  }

  async logs(
    envId: string,
    opts: { source?: string; since?: string; until?: string; limit?: number; deployment?: number },
  ): Promise<LogLine[]> {
    const where = ['env_id = ?']
    const params: SQLInputValue[] = [envId]
    if (opts.source) {
      where.push('source = ?')
      params.push(opts.source)
    }
    if (opts.since) {
      where.push('ts >= ?')
      params.push(opts.since)
    }
    if (opts.until) {
      where.push('ts <= ?')
      params.push(opts.until)
    }
    if (opts.deployment !== undefined) {
      where.push('deployment = ?')
      params.push(opts.deployment)
    }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000)
    const rows = await this.all<LogLine>(
      `SELECT id, ts, source, level, line, deployment FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      ...params,
      limit,
    )
    return rows.reverse()
  }

  // ---- activity ----------------------------------------------------------

  async recordActivity(
    appId: string,
    env: string | null,
    actor: string,
    action: string,
    detail?: unknown,
  ): Promise<void> {
    await this.run(
      'INSERT INTO activity (app_id, env, actor, action, detail, ts) VALUES (?, ?, ?, ?, ?, ?)',
      appId,
      env,
      actor,
      action,
      detail === undefined ? null : JSON.stringify(detail),
      now(),
    )
  }

  // ---- snapshots ---------------------------------------------------------

  async snapshot(
    appId: string,
    id: string,
  ): Promise<{ id: string; manifest: SnapshotFile[]; files: number; bytes: number; created_at: string } | undefined> {
    const r = await this.get<{ id: string; manifest: string; files: number; bytes: number; created_at: string }>(
      'SELECT * FROM snapshots WHERE app_id = ? AND id = ?',
      appId,
      id,
    )
    return r ? { ...r, manifest: JSON.parse(r.manifest) } : undefined
  }

  // ---- volumes (F10) -----------------------------------------------------

  /** BoxLite volumes this CP created (or adopted from its own pre-F10 records) for the env. */
  async envVolumes(envId: string): Promise<{ name: string; volume_id: string }[]> {
    return (
      await this.all<{ name: string; volume_id: string }>(
        'SELECT name, volume_id FROM env_volumes WHERE env_id = ? ORDER BY name',
        envId,
      )
    ).map((r) => ({ name: r.name, volume_id: r.volume_id }))
  }

  async recordVolume(envId: string, name: string, volumeId: string): Promise<void> {
    await this.run(
      'INSERT INTO env_volumes (env_id, name, volume_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (env_id, name) DO UPDATE SET volume_id = excluded.volume_id',
      envId,
      name,
      volumeId,
      now(),
    )
  }

  async forgetVolume(envId: string, name: string): Promise<void> {
    await this.run('DELETE FROM env_volumes WHERE env_id = ? AND name = ?', envId, name)
  }

  // ---- secrets -----------------------------------------------------------
}
