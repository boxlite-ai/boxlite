import { contextFindings, type AgentContext, type AgentDatabase, type AgentSchedule, type AgentService, type AgentVariable } from '@microcloud/shared';
import { orgSecret } from './orgs.js';
import { Cron } from 'croner';
import type { AppRow, EnvRow } from './db.js';
import type { Ctx } from './ctx.js';
import type { ServiceState } from './supervisor.js';
import { authStatus } from './enduser/management.js';
import type { Spec } from './spec.js';
import { envStatus } from './views.js';
import { storedLevelsAtLeast } from './services/logs.js';

const ERROR_LEVELS = storedLevelsAtLeast('error');

const RECENT_ERRORS = 20;
const ERROR_WINDOW_MS = 24 * 3_600_000;

/** The declared services with their reported state (`reported`: live when the Box is up, else the last report). */
function servicesOf(spec: Spec | undefined, reported: ServiceState[], boxState: string | null): AgentService[] {
  const byName = new Map(reported.map((s) => [s.name, s]));
  const exposed = spec?.services.find((s) => s.port !== undefined || s.static !== undefined);
  return (spec?.services ?? []).map((s) => {
    const r = byName.get(s.name);
    return {
      name: s.name,
      exposed: s === exposed,
      command: s.command ?? null,
      static: s.static ?? null,
      health_path: s === exposed && s.command ? (s.health ?? '/') : null,
      state: r ? (boxState === 'stopped' ? 'stopped (Box asleep)' : (r.state ?? null)) : null,
      health: r?.health ?? null,
      restarts: r?.restarts ?? null,
      last_exit_code: r?.last_exit_code ?? null,
    };
  });
}

export function schedulesOf(ctx: Ctx, env: EnvRow, spec: Spec | undefined, at = new Date()): AgentSchedule[] {
  return (spec?.schedules ?? []).map((s) => {
    const run = ctx.store.get<{ last_run: string; last_status: number | null }>('SELECT last_run, last_status FROM schedule_runs WHERE env_id = ? AND name = ?', env.id, s.name);
    let next: string | null = null;
    try {
      next = new Cron(s.cron, { paused: true, timezone: 'UTC' }).nextRun(at)?.toISOString() ?? null;
    } catch {
      next = null;
    }
    return { name: s.name, cron: s.cron, target: s.target, next_run: env.live_deployment ? next : null, last_run: run?.last_run ?? null, last_status: run?.last_status ?? null };
  });
}

/** Live variables with their source; secret values and DATABASE_URL never leave the CP. */
export function variablesOf(ctx: Ctx, app: AppRow, env: EnvRow, spec: Spec | undefined): AgentVariable[] {
  const out: AgentVariable[] = [
    { name: 'BOXLITE_APP_URL', value: ctx.resources.appUrl(app.name, env.name), secret: false, source: 'platform', resolved: true },
    { name: 'BOXLITE_ENV', value: env.name, secret: false, source: 'platform', resolved: true },
    { name: 'BOXLITE_APP', value: app.name, secret: false, source: 'platform', resolved: true },
    { name: 'PORT', value: null, secret: false, source: 'platform (assigned per release)', resolved: true },
  ];
  if (spec?.database) out.push({ name: 'DATABASE_URL', value: null, secret: true, source: 'platform (database)', resolved: env.db_url !== null });
  for (const [name, value] of Object.entries(spec?.variables ?? {})) out.push({ name, value, secret: false, source: 'boxlite.toml', resolved: true });
  for (const [name, ref] of Object.entries(spec?.secrets ?? {})) out.push({ name, value: null, secret: true, source: `secret ${ref}`, resolved: orgSecret(ctx, app, ref) !== undefined });
  return out;
}

async function databaseOf(ctx: Ctx, env: EnvRow, spec: Spec | undefined): Promise<AgentDatabase | null> {
  if (!spec?.database) return null;
  if (!env.db_url) return { status: 'not_provisioned', branch: null, tables: [], migrations: [] };
  const latest = ctx.store.deploymentsWhere("env_id = ? AND kind IN ('deploy', 'apply') ORDER BY number DESC LIMIT 1", env.id)[0];
  const files = latest?.request.resolved_migrations ?? latest?.request.migrations?.map((m) => ({ file: m.file, sha256: m.sha256 })) ?? [];
  try {
    const applied = await ctx.appdb.listApplied(env.db_url);
    const res = await ctx.appdb.query(
      env.db_url,
      [
        `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
           FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'boxlite_migrations'
          ORDER BY c.table_name, c.ordinal_position`,
      ],
      { write: false },
    );
    const tables = new Map<string, AgentDatabase['tables'][number]>();
    for (const [table, column, type, nullable, def] of res.rows as (string | null)[][]) {
      if (!table || !column) continue;
      if (!tables.has(table)) tables.set(table, { name: table, columns: [] });
      tables.get(table)!.columns.push({ name: column, type: type ?? '', nullable: nullable === 'YES', default: def ?? null });
    }
    const done = new Map(applied.map((a) => [a.file, a]));
    const migrations: AgentDatabase['migrations'] = files.map((f) => {
      const a = done.get(f.file);
      done.delete(f.file);
      return a ? { file: f.file, status: a.sha256 === f.sha256 ? 'applied' : 'changed', deployment: a.deployment, applied_at: a.applied_at } : { file: f.file, status: 'pending', deployment: null, applied_at: null };
    });
    for (const a of done.values()) migrations.push({ file: a.file, status: 'applied', deployment: a.deployment, applied_at: a.applied_at });
    migrations.sort((x, y) => x.file.localeCompare(y.file));
    return { status: 'ready', branch: env.neon_branch_id, tables: [...tables.values()], migrations };
  } catch (err) {
    return { status: 'unreachable', branch: env.neon_branch_id, error: (err as Error).message.slice(0, 300), tables: [], migrations: [] };
  }
}

function recentErrors(ctx: Ctx, env: EnvRow, at: number): AgentContext['recent_errors'] {
  const since = new Date(at - ERROR_WINDOW_MS).toISOString();
  return ctx.store
    .all<{ ts: string; source: string; line: string; deployment: number | null }>(
      `SELECT ts, source, line, deployment FROM logs WHERE env_id = ? AND lower(level) IN (${ERROR_LEVELS.map(() => '?').join(', ')}) AND ts >= ? ORDER BY id DESC LIMIT ?`,
      env.id,
      ...ERROR_LEVELS,
      since,
      RECENT_ERRORS,
    )
    .reverse();
}

/** `GET /v1/apps/{app}/envs/{env}/context`: one round trip with everything an agent needs. */
export async function buildAgentContext(ctx: Ctx, app: AppRow, env: EnvRow, latestCli: string | null, at = new Date()): Promise<AgentContext> {
  const spec = ctx.resources.currentSpec(env);
  // Live, so a service that started crashing after go-live is in the context (and its next actions).
  const { box: boxState, services: reported } = await ctx.resources.liveServices(env);
  const services = servicesOf(spec, reported, boxState);
  const exposed = services.find((s) => s.exposed);
  const appUrl = ctx.resources.appUrl(app.name, env.name);
  const auth = authStatus(ctx, app, env);
  const live = env.live_deployment ? ctx.store.deployment(env.id, env.live_deployment) : undefined;
  const base: Omit<AgentContext, 'next_actions'> = {
    app: app.name,
    env: env.name,
    control_plane: ctx.config.publicUrl,
    generated_at: at.toISOString(),
    status: envStatus(ctx, env),
    urls: { app: appUrl, health: exposed?.health_path ? `${appUrl.replace(/\/+$/, '')}${exposed.health_path}` : null, login: auth.enabled ? auth.login_url : null },
    access: { level: ctx.resources.effectiveAccess(env), source: env.access_override ? 'online' : 'manifest' },
    environments: ctx.store.envs(app.id).map((e) => ({ name: e.name, status: envStatus(ctx, e), url: ctx.resources.appUrl(app.name, e.name) })),
    live: live ? { deployment: live.number, spec_version: live.spec_version, live_at: live.live_at } : null,
    box: env.box_id ? { id: env.box_id, state: boxState ?? 'unknown' } : null,
    runtime: spec ? { image: spec.runtime.image, size: spec.runtime.size, build: spec.runtime.build } : null,
    services,
    schedules: schedulesOf(ctx, env, spec, at),
    database: await databaseOf(ctx, env, spec),
    volumes: (spec?.volumes ?? []).map((v) => ({ name: v.name, mount: v.mount, mode: v.mode })),
    auth,
    variables: variablesOf(ctx, app, env, spec),
    deployments: ctx.store.deployments(env.id, 5).map((d) => ({ number: d.number, kind: d.kind, status: d.status, message: d.message, created_at: d.created_at, finished_at: d.finished_at, spec_version: d.spec_version, error: d.error })),
    recent_errors: recentErrors(ctx, env, at.getTime()),
    cli: { latest_version: latestCli },
  };
  return { ...base, next_actions: contextFindings(base) };
}
