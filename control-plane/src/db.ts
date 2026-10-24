import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Spec } from './spec.js';

/**
 * The CP's own state. One sqlite file in DATA_DIR; migrations are append-only and tracked with
 * PRAGMA user_version: a new migration goes at the END of this list, never between deployed ones (a
 * database that already counted that position would skip it). JSON columns are parsed in the row mappers below.
 */
const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
  `
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    neon_project_id TEXT,
    neon_main_branch_id TEXT,
    neon_host TEXT
  );
  CREATE TABLE keys (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    hash TEXT NOT NULL UNIQUE,
    last4 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE envs (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    from_env TEXT,
    with_data INTEGER NOT NULL DEFAULT 0,
    neon_branch_id TEXT,
    db_url TEXT,
    box_id TEXT,
    box_url TEXT,
    box_image TEXT,
    box_size TEXT,
    box_volumes TEXT,
    gateway_secret TEXT NOT NULL,
    access_override TEXT,
    next_deployment INTEGER NOT NULL DEFAULT 1,
    live_deployment INTEGER,
    requested_deployment INTEGER,
    services TEXT,
    services_at TEXT,
    UNIQUE (app_id, name)
  );
  CREATE TABLE box_tokens (
    hash TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE spec_versions (
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    deployment INTEGER,
    spec TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (env_id, version)
  );
  CREATE TABLE deployments (
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    spec_version INTEGER,
    base_version INTEGER,
    snapshot_id TEXT,
    steps TEXT NOT NULL DEFAULT '[]',
    changes TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    request TEXT NOT NULL,
    idempotency_key TEXT,
    release INTEGER,
    box_id TEXT,
    built INTEGER NOT NULL DEFAULT 0,
    restore_point TEXT,
    live_at TEXT,
    PRIMARY KEY (env_id, number)
  );
  CREATE UNIQUE INDEX deployments_idem ON deployments(env_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE TABLE deployment_events (
    env_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    data TEXT NOT NULL,
    ts TEXT NOT NULL,
    PRIMARY KEY (env_id, number, seq)
  );
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    manifest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    snapshot_id TEXT
  );
  CREATE TABLE snapshots (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    manifest TEXT NOT NULL,
    files INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (app_id, id)
  );
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    env_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    level TEXT NOT NULL,
    line TEXT NOT NULL,
    deployment INTEGER
  );
  CREATE INDEX logs_env ON logs(env_id, id);
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    env TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    ts TEXT NOT NULL
  );
  CREATE INDEX activity_app ON activity(app_id, id);
  CREATE TABLE org_secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE db_snapshots (
    id TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    message TEXT,
    ts TEXT NOT NULL,
    by TEXT NOT NULL
  );
  CREATE TABLE schedule_runs (
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    last_run TEXT NOT NULL,
    last_status INTEGER,
    PRIMARY KEY (env_id, name)
  );
  `,
  // End-user sign-in ([auth]): one user pool per app env, and server-side sessions so sign-out
  // and block take effect on the next request.
  `
  CREATE TABLE app_users (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    email TEXT,
    name TEXT,
    avatar_url TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0,
    UNIQUE (env_id, provider, provider_user_id)
  );
  CREATE INDEX app_users_email ON app_users(env_id, email);
  CREATE TABLE app_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX app_sessions_user ON app_sessions(user_id);
  `,
  // Soft delete (PRD 3.13): a deleted App keeps its resources and its name until purge_after.
  `
  ALTER TABLE apps ADD COLUMN deleted_at TEXT;
  ALTER TABLE apps ADD COLUMN purge_after TEXT;
  `,
  // One origin per app env (security review F1): each env gets a CP listener port and the public
  // URL of the tunnel to it. One-time "open app" tickets and sign-in handoff codes are stored hashed.
  `
  ALTER TABLE envs ADD COLUMN port INTEGER;
  ALTER TABLE envs ADD COLUMN public_url TEXT;
  CREATE UNIQUE INDEX envs_port ON envs(port) WHERE port IS NOT NULL;
  CREATE TABLE cp_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE open_tickets (
    hash TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    next TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE auth_handoffs (
    hash TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    next TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  `,
  // Security review F3: the control secret (X-BoxLite-Control, CP → supervisor control calls only) is
  // separate from the forwarding secret, which keeps the column name gateway_secret (forward_secret since migration 7). Existing envs get
  // one now; the trigger gives every future env one, whichever code path inserts it.
  // Security review F10: the BoxLite volumes the CP created for an env, by id, so deletion never
  // matches by name.
  `
  ALTER TABLE envs ADD COLUMN control_secret TEXT NOT NULL DEFAULT '';
  UPDATE envs SET control_secret = lower(hex(randomblob(24))) WHERE control_secret = '';
  CREATE TRIGGER envs_control_secret AFTER INSERT ON envs WHEN NEW.control_secret = ''
  BEGIN
    UPDATE envs SET control_secret = lower(hex(randomblob(24))) WHERE id = NEW.id;
  END;
  CREATE TABLE env_volumes (
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (env_id, name)
  );
  `,
  // Security review F5: the password of the Neon-managed read-only role (boxlite_reader) per branch.
  // A secret: read only by dbreader.ts, never put in a spec, a log, the agent context or the console.
  `
  CREATE TABLE IF NOT EXISTS db_readers (
    project_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    password TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, branch_id)
  );
  `,
  // Code health 2026-10-22:
  //  - envs.gateway_secret is renamed to what it is and what the wire calls it, forward_secret.
  //  - apps.neon_host was written and never read.
  //  - Apply deployments record the snapshot of the release they restart, so their source can be
  //    downloaded (`app clone`); older applies get it from the release they ran.
  //  - console_access (the proxy's request log) moves under the migrations, keyed to its env, so
  //    deleting an env or purging an app removes its rows.
  `
  ALTER TABLE envs RENAME COLUMN gateway_secret TO forward_secret;
  ALTER TABLE apps DROP COLUMN neon_host;
  UPDATE deployments SET snapshot_id = (
      SELECT r.snapshot_id FROM deployments r WHERE r.env_id = deployments.env_id AND r.number = deployments.release
    )
    WHERE kind = 'apply' AND snapshot_id IS NULL AND release IS NOT NULL;
  CREATE TABLE IF NOT EXISTS console_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    env_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    ms INTEGER NOT NULL
  );
  CREATE TABLE console_access_v7 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    env_id TEXT NOT NULL REFERENCES envs(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    ms INTEGER NOT NULL
  );
  INSERT INTO console_access_v7 (id, env_id, ts, method, path, status, ms)
    SELECT id, env_id, ts, method, path, status, ms FROM console_access WHERE env_id IN (SELECT id FROM envs);
  DROP TABLE console_access;
  ALTER TABLE console_access_v7 RENAME TO console_access;
  CREATE INDEX console_access_env ON console_access(env_id, id);
  `,
  // Agents' reports about the platform (boxlite-app feedback "<message>"); kept when the App is purged.
  `
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    env TEXT,
    actor TEXT NOT NULL,
    message TEXT NOT NULL,
    command TEXT,
    cli_version TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS feedback_app ON feedback(app_id, created_at);
  `,
  // Console users and organizations, as on the BoxLite platform (orgs.ts): every user gets a
  // Default Organization; Apps and org secrets belong to an org. What existed before goes to the
  // platform's Default Organization (org_platform), which the legacy owner takes on first sign-in.
  (db) => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS console_users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      login TEXT,
      email TEXT,
      name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT NOT NULL,
      UNIQUE (provider, provider_id)
    );
    CREATE TABLE IF NOT EXISTS console_handoffs (
      hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      next TEXT NOT NULL,
      browser_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      suspended_reason TEXT,
      app_limit INTEGER
    );
    CREATE TABLE IF NOT EXISTS org_members (
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (org_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS org_members_user ON org_members(user_id);
    INSERT OR IGNORE INTO orgs (id, name, created_by, created_at) VALUES ('org_platform', 'Default Organization', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!columns('apps').includes('org_id')) db.exec('ALTER TABLE apps ADD COLUMN org_id TEXT');
    db.exec("UPDATE apps SET org_id = 'org_platform' WHERE org_id IS NULL");
    if (!columns('org_secrets').includes('org_id')) {
      db.exec(`
      CREATE TABLE org_secrets_v9 (org_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (org_id, name));
      INSERT INTO org_secrets_v9 (org_id, name, value, updated_at) SELECT 'org_platform', name, value, updated_at FROM org_secrets;
      DROP TABLE org_secrets;
      ALTER TABLE org_secrets_v9 RENAME TO org_secrets;
      `);
    }
  },
  // An App's own OAuth clients for end-user sign-in (enduser/config.ts oauthClientFor), set in the console.
  `
  CREATE TABLE IF NOT EXISTS app_oauth_clients (
    app_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (app_id, provider)
  );
  `,
  // Superseded by app_sessions.role (below): a role belongs to one test session, not to the user. Kept so
  // databases that ran it still replay; nothing reads app_users.test_role.
  (db) => {
    const columns = (db.prepare('PRAGMA table_info(app_users)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('test_role')) db.exec('ALTER TABLE app_users ADD COLUMN test_role TEXT');
  },
  // An App's own secret values (orgs.ts secretValue): set by its agent or in the console, referenced as app/<name>.
  `
  CREATE TABLE IF NOT EXISTS app_secrets (
    app_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (app_id, name)
  );
  `,
  // A one-time link may sign the browser in as a test user (`app open --as`): who, and with which role.
  (db) => {
    const columns = (db.prepare('PRAGMA table_info(open_tickets)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('as_email')) db.exec('ALTER TABLE open_tickets ADD COLUMN as_email TEXT');
    if (!columns.includes('as_role')) db.exec('ALTER TABLE open_tickets ADD COLUMN as_role TEXT');
  },
  // The role a test session signs in with (enduser/role.ts); real users' roles come from org membership.
  (db) => {
    const columns = (db.prepare('PRAGMA table_info(app_sessions)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('role')) db.exec('ALTER TABLE app_sessions ADD COLUMN role TEXT');
  },
  // Repair: the open_tickets migration above was once inserted before app_secrets, after databases
  // had already counted that position, so some never ran it. Idempotent; a no-op where it did run.
  (db) => {
    const columns = (db.prepare('PRAGMA table_info(open_tickets)').all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes('as_email')) db.exec('ALTER TABLE open_tickets ADD COLUMN as_email TEXT');
    if (!columns.includes('as_role')) db.exec('ALTER TABLE open_tickets ADD COLUMN as_role TEXT');
  },
  // Email code sign-in (docs/email-sign-in.md): the App's SMTP sender, and the codes mailed to end users.
  `
  CREATE TABLE IF NOT EXISTS app_email_senders (
    app_id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT,
    password TEXT,
    from_address TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_email_codes (
    id TEXT PRIMARY KEY,
    env_id TEXT NOT NULL,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    next TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE INDEX IF NOT EXISTS auth_email_codes_by_email ON auth_email_codes (env_id, email, created_at);
  `,
  // Notes an agent keeps for the next session on the App (`app remember`, services/notes.ts).
  `
  CREATE TABLE IF NOT EXISTS app_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL,
    text TEXT NOT NULL,
    by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS app_notes_by_app ON app_notes (app_id, id);
  `,
];

export const LOG_RING_SIZE = 20_000;

export interface AppRow {
  id: string;
  name: string;
  created_at: string;
  neon_project_id: string | null;
  neon_main_branch_id: string | null;
  deleted_at?: string | null;
  purge_after?: string | null;
  /** The organization it belongs to (orgs.ts); org_platform for Apps from before organizations. */
  org_id?: string | null;
}

export interface EnvRow {
  id: string;
  app_id: string;
  name: string;
  created_at: string;
  from_env: string | null;
  with_data: number;
  neon_branch_id: string | null;
  db_url: string | null;
  box_id: string | null;
  box_url: string | null;
  box_image: string | null;
  box_size: string | null;
  box_volumes: string | null;
  /** The forwarding secret: X-BoxLite-Gateway on proxied end-user traffic only (supervisor.ts forwardHeaders). */
  forward_secret: string;
  /** X-BoxLite-Control on the CP's own /.boxlite/sv/* calls only (supervisor.ts controlHeaders). */
  control_secret: string;
  access_override: string | null;
  next_deployment: number;
  live_deployment: number | null;
  requested_deployment: number | null;
  services: string | null;
  services_at: string | null;
  /** CP listener port of the env's own origin (origins.ts); null until allocated. */
  port?: number | null;
  /** The env's origin URL (tunnel to `port`), no trailing slash. */
  public_url?: string | null;
}

export type DeploymentKind = 'deploy' | 'apply' | 'rollback';
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
  | 'rolled_back';

export const ACTIVE_STATUSES: DeploymentStatus[] = ['queued', 'uploading', 'building', 'migrating', 'starting'];

export interface Step {
  name: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  ms?: number;
  /** Human detail the CLI prints as-is. */
  detail?: string;
}

export interface Change {
  kind: '+' | '~' | '-' | 'online_only';
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface MigrationFile {
  file: string;
  sha256: string;
  sql: string;
}

/** What the CLI asked for, persisted so the orchestrator (and a restarted CP) can run it later. */
export interface DeploymentRequest {
  kind: DeploymentKind;
  manifest?: import('@microcloud/shared').Manifest;
  migrations?: MigrationFile[];
  /** Migration files (without SQL) the job actually used, for GET /db/migrations. */
  resolved_migrations?: { file: string; sha256: string }[];
  force?: boolean;
  to?: number;
  with_database?: boolean;
}

export interface DeploymentError {
  step: string;
  message: string;
  log_tail?: string[];
}

export interface Deployment {
  env_id: string;
  number: number;
  kind: DeploymentKind;
  status: DeploymentStatus;
  message: string | null;
  by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  spec_version: number | null;
  base_version: number | null;
  snapshot_id: string | null;
  steps: Step[];
  changes: Change[];
  error: DeploymentError | null;
  request: DeploymentRequest;
  idempotency_key: string | null;
  release: number | null;
  box_id: string | null;
  built: boolean;
  restore_point: string | null;
  live_at: string | null;
}

export interface SnapshotFile {
  path: string;
  size: number;
  mode: number;
  sha256: string;
}

export interface LogLine {
  id?: number;
  ts: string;
  source: string;
  level: string;
  line: string;
  deployment?: number | null;
}

type Row = Record<string, SQLInputValue>;

export const now = (): string => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        const m = MIGRATIONS[v]!;
        if (typeof m === 'string') this.db.exec(m);
        else m(this.db);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- apps / envs -------------------------------------------------------

  appByName(name: string): AppRow | undefined {
    return this.get<AppRow>('SELECT * FROM apps WHERE name = ? AND deleted_at IS NULL', name);
  }

  /** Includes soft-deleted Apps; only lifecycle code and the proxy's "app deleted" page use it. */
  appByNameAnyState(name: string): AppRow | undefined {
    return this.get<AppRow>('SELECT * FROM apps WHERE name = ?', name);
  }

  /** Live Apps, newest first. */
  apps(): AppRow[] {
    return this.all<AppRow>('SELECT * FROM apps WHERE deleted_at IS NULL ORDER BY created_at DESC');
  }

  /** Soft-deleted Apps (PRD 3.13), most recently deleted first. */
  deletedApps(): AppRow[] {
    return this.all<AppRow>('SELECT * FROM apps WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
  }

  appById(id: string): AppRow | undefined {
    return this.get<AppRow>('SELECT * FROM apps WHERE id = ?', id);
  }

  envByName(appId: string, name: string): EnvRow | undefined {
    return this.get<EnvRow>('SELECT * FROM envs WHERE app_id = ? AND name = ?', appId, name);
  }

  envById(id: string): EnvRow | undefined {
    return this.get<EnvRow>('SELECT * FROM envs WHERE id = ?', id);
  }

  envs(appId: string): EnvRow[] {
    return this.all<EnvRow>("SELECT * FROM envs WHERE app_id = ? ORDER BY name = 'main' DESC, created_at", appId);
  }

  updateEnv(id: string, fields: Partial<Omit<EnvRow, 'id'>>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.run(`UPDATE envs SET ${sets} WHERE id = ?`, ...keys.map((k) => (fields as Row)[k] ?? null), id);
  }

  updateApp(id: string, fields: Partial<Omit<AppRow, 'id'>>): void {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.run(`UPDATE apps SET ${sets} WHERE id = ?`, ...keys.map((k) => (fields as Row)[k] ?? null), id);
  }

  // ---- specs -------------------------------------------------------------

  latestSpecVersion(envId: string): number {
    const row = this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM spec_versions WHERE env_id = ?', envId);
    return row?.v ?? 0;
  }

  /**
   * The newest spec version that took effect or is still on its way: failed and cancelled
   * deployments never changed the env, so they must not make the next deploy look stale.
   */
  effectiveSpecVersion(envId: string): number {
    const row = this.get<{ v: number | null }>(
      `SELECT MAX(sv.version) AS v FROM spec_versions sv
         LEFT JOIN deployments d ON d.env_id = sv.env_id AND d.number = sv.deployment
        WHERE sv.env_id = ? AND (d.status IS NULL OR d.status NOT IN ('failed', 'cancelled'))`,
      envId,
    );
    return row?.v ?? 0;
  }

  spec(envId: string, version?: number): Spec | undefined {
    const row =
      version === undefined
        ? this.get<{ spec: string }>('SELECT spec FROM spec_versions WHERE env_id = ? ORDER BY version DESC LIMIT 1', envId)
        : this.get<{ spec: string }>('SELECT spec FROM spec_versions WHERE env_id = ? AND version = ?', envId, version);
    return row ? (JSON.parse(row.spec) as Spec) : undefined;
  }

  insertSpec(envId: string, spec: Spec): void {
    this.run(
      'INSERT INTO spec_versions (env_id, version, deployment, spec, created_at) VALUES (?, ?, ?, ?, ?)',
      envId,
      spec.version,
      spec.deployment,
      JSON.stringify(spec),
      now(),
    );
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
    };
  }

  deployment(envId: string, number: number): Deployment | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM deployments WHERE env_id = ? AND number = ?', envId, number);
    return r ? this.mapDeployment(r) : undefined;
  }

  deploymentByIdempotencyKey(envId: string, key: string): Deployment | undefined {
    const r = this.get<Record<string, unknown>>('SELECT * FROM deployments WHERE env_id = ? AND idempotency_key = ?', envId, key);
    return r ? this.mapDeployment(r) : undefined;
  }

  deployments(envId: string, limit = 20): Deployment[] {
    return this.all<Record<string, unknown>>('SELECT * FROM deployments WHERE env_id = ? ORDER BY number DESC LIMIT ?', envId, limit).map((r) =>
      this.mapDeployment(r),
    );
  }

  deploymentsWhere(where: string, ...params: SQLInputValue[]): Deployment[] {
    return this.all<Record<string, unknown>>(`SELECT * FROM deployments WHERE ${where}`, ...params).map((r) => this.mapDeployment(r));
  }

  /** Allocates the next deployment number for the env and inserts the row, atomically. */
  insertDeployment(d: Omit<Deployment, 'number' | 'env_id'>, envId: string): Deployment {
    return this.tx(() => {
      const env = this.envById(envId);
      if (!env) throw new Error(`env ${envId} vanished`);
      const number = env.next_deployment;
      this.run('UPDATE envs SET next_deployment = ? WHERE id = ?', number + 1, envId);
      this.run(
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
      );
      return this.deployment(envId, number)!;
    });
  }

  updateDeployment(envId: string, number: number, fields: Partial<Omit<Deployment, 'env_id' | 'number'>>): Deployment {
    const cols: string[] = [];
    const vals: SQLInputValue[] = [];
    for (const [k, v] of Object.entries(fields)) {
      cols.push(`${k} = ?`);
      if (k === 'steps' || k === 'changes' || k === 'request') vals.push(JSON.stringify(v));
      else if (k === 'error') vals.push(v ? JSON.stringify(v) : null);
      else if (k === 'built') vals.push(v ? 1 : 0);
      else vals.push((v ?? null) as SQLInputValue);
    }
    if (cols.length) this.run(`UPDATE deployments SET ${cols.join(', ')} WHERE env_id = ? AND number = ?`, ...vals, envId, number);
    return this.deployment(envId, number)!;
  }

  // ---- deployment events -------------------------------------------------

  insertEvent(envId: string, number: number, event: string, data: unknown): number {
    const row = this.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM deployment_events WHERE env_id = ? AND number = ?', envId, number);
    const seq = (row?.s ?? 0) + 1;
    this.run('INSERT INTO deployment_events (env_id, number, seq, event, data, ts) VALUES (?, ?, ?, ?, ?, ?)', envId, number, seq, event, JSON.stringify(data), now());
    return seq;
  }

  events(envId: string, number: number, afterSeq = 0): { seq: number; event: string; data: unknown }[] {
    return this.all<{ seq: number; event: string; data: string }>(
      'SELECT seq, event, data FROM deployment_events WHERE env_id = ? AND number = ? AND seq > ? ORDER BY seq',
      envId,
      number,
      afterSeq,
    ).map((r) => ({ seq: r.seq, event: r.event, data: JSON.parse(r.data) }));
  }

  // ---- logs --------------------------------------------------------------

  /** Appends lines and trims the env's ring to LOG_RING_SIZE. */
  appendLogs(envId: string, lines: LogLine[]): LogLine[] {
    const out: LogLine[] = [];
    this.tx(() => {
      const ins = this.db.prepare('INSERT INTO logs (env_id, ts, source, level, line, deployment) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of lines) {
        const r = ins.run(envId, l.ts, l.source, l.level, l.line, l.deployment ?? null);
        out.push({ ...l, id: Number(r.lastInsertRowid) });
      }
      const cut = this.get<{ id: number }>('SELECT id FROM logs WHERE env_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?', envId, LOG_RING_SIZE);
      if (cut) this.run('DELETE FROM logs WHERE env_id = ? AND id <= ?', envId, cut.id);
    });
    return out;
  }

  logs(envId: string, opts: { source?: string; since?: string; until?: string; limit?: number; deployment?: number }): LogLine[] {
    const where = ['env_id = ?'];
    const params: SQLInputValue[] = [envId];
    if (opts.source) {
      where.push('source = ?');
      params.push(opts.source);
    }
    if (opts.since) {
      where.push('ts >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      where.push('ts <= ?');
      params.push(opts.until);
    }
    if (opts.deployment !== undefined) {
      where.push('deployment = ?');
      params.push(opts.deployment);
    }
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000);
    const rows = this.all<LogLine>(`SELECT id, ts, source, level, line, deployment FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...params, limit);
    return rows.reverse();
  }

  // ---- activity ----------------------------------------------------------

  recordActivity(appId: string, env: string | null, actor: string, action: string, detail?: unknown): void {
    this.run('INSERT INTO activity (app_id, env, actor, action, detail, ts) VALUES (?, ?, ?, ?, ?, ?)', appId, env, actor, action, detail === undefined ? null : JSON.stringify(detail), now());
  }

  // ---- snapshots ---------------------------------------------------------

  snapshot(appId: string, id: string): { id: string; manifest: SnapshotFile[]; files: number; bytes: number; created_at: string } | undefined {
    const r = this.get<{ id: string; manifest: string; files: number; bytes: number; created_at: string }>('SELECT * FROM snapshots WHERE app_id = ? AND id = ?', appId, id);
    return r ? { ...r, manifest: JSON.parse(r.manifest) } : undefined;
  }

  // ---- volumes (F10) -----------------------------------------------------

  /** BoxLite volumes this CP created (or adopted from its own pre-F10 records) for the env. */
  envVolumes(envId: string): { name: string; volume_id: string }[] {
    return this.all<{ name: string; volume_id: string }>('SELECT name, volume_id FROM env_volumes WHERE env_id = ? ORDER BY name', envId).map((r) => ({ name: r.name, volume_id: r.volume_id }));
  }

  recordVolume(envId: string, name: string, volumeId: string): void {
    this.run('INSERT INTO env_volumes (env_id, name, volume_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (env_id, name) DO UPDATE SET volume_id = excluded.volume_id', envId, name, volumeId, now());
  }

  forgetVolume(envId: string, name: string): void {
    this.run('DELETE FROM env_volumes WHERE env_id = ? AND name = ?', envId, name);
  }

  // ---- secrets -----------------------------------------------------------

}
