import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCloudAppPlatform1793780100000 implements MigrationInterface {
  name = 'AddCloudAppPlatform1793780100000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA cloud_app;
CREATE TABLE cloud_app.box_tunnels (
 box_id TEXT PRIMARY KEY,
 organization_id UUID NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
 url TEXT NOT NULL,
 encrypted_token TEXT NOT NULL
);
CREATE TABLE cloud_app.apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    neon_project_id TEXT,
    neon_main_branch_id TEXT,
    deleted_at TIMESTAMPTZ, purge_after TIMESTAMPTZ, org_id UUID NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE , UNIQUE (org_id, name));
CREATE TABLE cloud_app.envs (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    from_env TEXT,
    with_data INTEGER NOT NULL DEFAULT 0,
    neon_branch_id TEXT,
    db_url TEXT,
    box_id TEXT,
    box_url TEXT,
    box_image TEXT,
    box_size TEXT,
    box_volumes TEXT,
    forward_secret TEXT NOT NULL,
    access_override TEXT,
    next_deployment INTEGER NOT NULL DEFAULT 1,
    live_deployment INTEGER,
    requested_deployment INTEGER,
    services JSONB,
    services_at TIMESTAMPTZ, public_url TEXT, control_secret TEXT NOT NULL,
    UNIQUE (app_id, name)
  );
CREATE TABLE cloud_app.box_tokens (
    hash TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
  );
CREATE TABLE cloud_app.spec_versions (
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    deployment INTEGER,
    spec JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (env_id, version)
  );
CREATE TABLE cloud_app.deployments (
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    spec_version INTEGER,
    base_version INTEGER,
    snapshot_id TEXT,
    steps JSONB NOT NULL DEFAULT '[]',
    changes JSONB NOT NULL DEFAULT '[]',
    error JSONB,
    request JSONB NOT NULL,
    idempotency_key TEXT,
    release INTEGER,
    box_id TEXT,
    built INTEGER NOT NULL DEFAULT 0,
    restore_point TIMESTAMPTZ,
    live_at TIMESTAMPTZ,
    PRIMARY KEY (env_id, number)
  );
CREATE TABLE cloud_app.deployment_events (
    env_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    data JSONB NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (env_id, number, seq)
  );
CREATE TABLE cloud_app.uploads (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    manifest JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    snapshot_id TEXT
  );
CREATE TABLE cloud_app.snapshots (
    app_id TEXT NOT NULL REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    manifest JSONB NOT NULL,
    files INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (app_id, id)
  );
CREATE TABLE cloud_app.logs (
    id BIGSERIAL PRIMARY KEY,
    env_id TEXT NOT NULL,
    ts TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL,
    level TEXT NOT NULL,
    line TEXT NOT NULL,
    deployment INTEGER
  );
CREATE TABLE cloud_app.activity (
    id BIGSERIAL PRIMARY KEY,
    app_id TEXT NOT NULL,
    env TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail JSONB,
    ts TIMESTAMPTZ NOT NULL
  );
CREATE TABLE cloud_app.db_snapshots (
    id TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    message TEXT,
    ts TIMESTAMPTZ NOT NULL,
    by TEXT NOT NULL
  );
CREATE TABLE cloud_app.schedule_runs (
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    last_run TIMESTAMPTZ NOT NULL,
    last_status INTEGER,
    PRIMARY KEY (env_id, name)
  );
CREATE TABLE cloud_app.app_users (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    email TEXT,
    name TEXT,
    avatar_url TEXT,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0, test_role TEXT,
    UNIQUE (env_id, provider, provider_user_id)
  );
CREATE TABLE cloud_app.app_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES cloud_app.app_users(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
  , role TEXT);
CREATE TABLE cloud_app.open_tickets (
    hash TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    next TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  , as_email TEXT, as_role TEXT);
CREATE TABLE cloud_app.auth_handoffs (
    hash TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES cloud_app.app_users(id) ON DELETE CASCADE,
    next TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  );
CREATE TABLE cloud_app.env_volumes (
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    volume_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (env_id, name)
  );
CREATE TABLE cloud_app.db_readers (
    project_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    password TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, branch_id)
  );
CREATE TABLE cloud_app.console_access (
    id BIGSERIAL PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    ts TIMESTAMPTZ NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    ms INTEGER NOT NULL
  );
CREATE TABLE cloud_app.feedback (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    env TEXT,
    actor TEXT NOT NULL,
    message TEXT NOT NULL,
    command TEXT,
    cli_version TEXT,
    created_at TIMESTAMPTZ NOT NULL
  );
CREATE TABLE cloud_app.org_secrets (org_id UUID NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (org_id, name));
CREATE TABLE cloud_app.app_oauth_clients (
    app_id TEXT NOT NULL REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (app_id, provider)
  );
CREATE TABLE cloud_app.app_secrets (
    app_id TEXT NOT NULL REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (app_id, name)
  );
CREATE TABLE cloud_app.app_email_senders (
    app_id TEXT PRIMARY KEY REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT,
    password TEXT,
    from_address TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
CREATE TABLE cloud_app.auth_email_codes (
    id TEXT PRIMARY KEY,
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    browser_hash TEXT NOT NULL,
    next TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
  );
CREATE TABLE cloud_app.app_notes (
    id BIGSERIAL PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES cloud_app.apps(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
CREATE TABLE cloud_app.finding_acks (
    env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
    finding_id TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (env_id, finding_id)
  );
CREATE UNIQUE INDEX deployments_idem ON cloud_app.deployments(env_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX logs_env ON cloud_app.logs(env_id, id);
CREATE INDEX activity_app ON cloud_app.activity(app_id, id);
CREATE INDEX app_users_email ON cloud_app.app_users(env_id, email);
CREATE INDEX app_sessions_user ON cloud_app.app_sessions(user_id);
CREATE INDEX console_access_env ON cloud_app.console_access(env_id, id);
CREATE INDEX feedback_app ON cloud_app.feedback(app_id, created_at);
CREATE INDEX auth_email_codes_by_email ON cloud_app.auth_email_codes (env_id, email, created_at);
CREATE INDEX app_notes_by_app ON cloud_app.app_notes (app_id, id);
ALTER TABLE cloud_app.deployments ADD COLUMN worker_owner TEXT, ADD COLUMN heartbeat_at TIMESTAMPTZ, ADD COLUMN cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE cloud_app.previews (env_id TEXT PRIMARY KEY REFERENCES cloud_app.envs(id) ON DELETE CASCADE,captured_at TIMESTAMPTZ NOT NULL,deployment INTEGER NOT NULL,image BYTEA NOT NULL);
CREATE TABLE cloud_app.supervisor_status (env_id TEXT NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE, release INTEGER NOT NULL, status JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(env_id,release));
`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP SCHEMA cloud_app CASCADE')
  }
}
