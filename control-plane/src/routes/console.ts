import { deleteApp, restoreApp } from '../lifecycle.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { buffer } from 'node:stream/consumers';
import type { Manifest } from '@microcloud/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { newAppKey, newId, sha256hex } from '../auth.js';
import { AccessLog } from '../console-access.js';
import { CONSOLE_USER, loginRoutes, requireConsoleApi, requireConsolePage } from '../console-auth.js';
import { endUserAuth } from '../console-enduser.js';
import { activityView, actorLabel } from '../console-activity.js';
import { deploymentChanges, failureView, type Timeline } from '../console-deployment.js';
import { detailView, environmentViews, handoffPrompt, releaseId, releaseViews, summaryView } from '../console-views.js';
import type { AppRow, Deployment, EnvRow, MigrationFile } from '../db.js';
import { ACTIVE_STATUSES, now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { HttpError, fail } from '../errors.js';
import { RESERVED_NAMES } from '../platform.js';
import type { Spec } from '../spec.js';
import { createApp } from './apps.js';
import { parseSince } from './logs.js';
import { createOpenTicket } from './proxy.js';
import { body, type C } from './util.js';

/**
 * The console API (/console/api) and the console's static files (/console/). The API speaks the
 * shapes of the dashboard's Apps screens and is built from real CP state. Writes go through the
 * CP's own /v1 routes in-process (as `admin`), so validation, activity and the orchestrator are
 * exactly what the CLI gets.
 */

// The console owns /console on the CP host, and end-user sign-in will own /auth, so no app may be called that.
RESERVED_NAMES.add('console');
RESERVED_NAMES.add('auth');

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLATFORM_VARS = /^(BOXLITE_.*|DATABASE_URL|PORT)$/;
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

const TABLES = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name";
/** Exact row counts of the given tables in one statement (the SQL guard refuses dynamic SQL, so it is built here). */
const countsQuery = (tables: string[]) => tables.map((t) => `SELECT ${`'${t.replace(/'/g, "''")}'`}, count(*) FROM public.${quoteIdent(t)}`).join(' UNION ALL ');

/** Neon free plan: point-in-time restore reaches 6 hours back. */
const RESTORE_WINDOW_HOURS = 6;

type Cp = <T>(method: string, path: string, json?: unknown) => Promise<T>;
type Raw = (method: string, path: string, body?: ArrayBuffer) => Promise<Response>;

/** Activity names console actions `console`; `admin` is left for the admin token used directly. */
const ACTOR = 'console';

/** Calls a CP route in-process with the admin token, as actor `console`; a CP error is re-thrown unchanged. */
function cpClient(root: Hono, ctx: Ctx): { call: Cp; raw: Raw } {
  const request = (method: string, path: string, body: string | ArrayBuffer | undefined, type: string | undefined) =>
    Promise.resolve(
      root.request(path, {
        method,
        headers: { authorization: `Bearer ${ctx.config.adminToken}`, 'x-boxlite-actor': ACTOR, ...(type ? { 'content-type': type } : {}) },
        ...(body !== undefined ? { body } : {}),
      }),
    );
  const raw: Raw = (method, path, body) => request(method, path, body, body ? 'application/octet-stream' : undefined);
  const call: Cp = async <T>(method: string, path: string, json?: unknown) => {
    const res = await request(method, path, json === undefined ? undefined : JSON.stringify(json), json === undefined ? undefined : 'application/json');
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string; next?: string } } | undefined)?.error;
      const { code, message, next, ...details } = (e ?? {}) as Record<string, unknown>;
      throw new HttpError(res.status, String(code ?? 'error'), String(message ?? (text || res.statusText)), next as string | undefined, details);
    }
    return parsed as T;
  };
  return { call, raw };
}

/** JSON-safe cells: dates and json columns would otherwise render as [object Object]. */
function cells(rows: unknown[][]): unknown[][] {
  return rows.map((r) => r.map((v) => (v === null || typeof v !== 'object' ? v : v instanceof Date ? v.toISOString() : JSON.stringify(v))));
}

export function mountConsole(root: Hono, ctx: Ctx): void {
  const access = new AccessLog(ctx);
  const login = loginRoutes(ctx.config);
  root.get('/console/login', login.page);
  root.post('/console/login', login.submit);
  root.on(['GET', 'POST'], '/console/logout', login.logout);
  root.route('/console/api', consoleApi(root, ctx, access));
  root.get('/console', (c) => c.redirect('/console/', 308));
  root.get('/console/*', requireConsolePage(ctx.config), staticHandler);
}

/**
 * Console "Delete app": deletes every env's Box and volumes and the Neon project, then the app's CP
 * rows. Refused while a deployment runs. (To be replaced by lifecycle.ts deleteApp, a soft delete.)
 */
/** The console's Delete is the soft delete of PRD 3.13; the purger removes resources later. */
export async function deleteAppNow(ctx: Ctx, _access: AccessLog, app: AppRow): Promise<void> {
  await deleteApp(ctx, app, ACTOR);
}

// ---- static files -------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export const consoleDir = () => resolve(process.env.CONSOLE_DIR ?? '../console-dist');

function staticHandler(c: Context): Response {
  const dir = consoleDir();
  const rel = decodeURIComponent(new URL(c.req.url).pathname.slice('/console/'.length));
  const file = resolve(dir, rel || 'index.html');
  if (file !== dir && !file.startsWith(dir + sep)) return c.text('not found', 404);
  const isFile = existsSync(file) && statSync(file).isFile();
  // SPA fallback: a route path (no extension) gets index.html; a missing asset is a 404.
  const target = isFile ? file : extname(rel) ? null : join(dir, 'index.html');
  if (!target || !existsSync(target)) {
    return c.text(target ? `The console is not built. Run deploy/build-console.sh (looked in ${dir}).` : 'not found', 404);
  }
  const hashed = target.includes(`${sep}assets${sep}`);
  return new Response(readFileSync(target), {
    headers: {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}

// ---- API ------------------------------------------------------------------------------

function consoleApi(root: Hono, ctx: Ctx, access: AccessLog) {
  const api = new Hono();
  const { store } = ctx;
  const { call: cp, raw } = cpClient(root, ctx);
  api.use('*', requireConsoleApi(ctx.config));

  const appOf = (c: Context): AppRow => {
    const name = c.req.param('id') ?? '';
    const app = store.appByName(name);
    if (!app) throw fail('not_found_app', `no app named "${name}"`);
    return app;
  };
  const envOf = (c: Context, app: AppRow): EnvRow => {
    const name = c.req.query('env') || 'main';
    const env = store.envByName(app.id, name);
    if (!env) throw fail('not_found_env', `no environment "${name}" in app "${app.name}"`);
    return env;
  };
  const v1 = (app: AppRow, env?: EnvRow) => `/v1/apps/${encodeURIComponent(app.name)}${env ? `/envs/${encodeURIComponent(env.name)}` : ''}`;
  const detail = async (app: AppRow, env: EnvRow) => detailView(ctx, access, app, env);
  const json = <T extends z.ZodType>(c: Context, schema: T) => body(c as unknown as C, schema);

  api.get('/session', (c) => c.json({ user: CONSOLE_USER, controlPlane: ctx.config.publicUrl, reservedNames: [...RESERVED_NAMES].sort() }));

  // ---- apps ----------------------------------------------------------------

  api.get('/apps', async (c) => {
    const apps = store.all<AppRow>('SELECT * FROM apps WHERE deleted_at IS NULL ORDER BY created_at DESC');
    return c.json(await Promise.all(apps.map((a) => summaryView(ctx, a))));
  });

  /** The key exists in clear text only in this response; the CP keeps its sha256. */
  api.post('/apps', async (c) => {
    const b = await json(c, z.object({ name: z.string().trim().min(1).max(64) }));
    const { app, key } = createApp(ctx, b.name, ACTOR);
    const env = store.envByName(app.id, 'main')!;
    return c.json({ app: await detail(app, env), key, prompt: handoffPrompt(ctx, app.name, key) }, 201);
  });

  /** Soft-deleted apps (PRD 3.13): kept until purge_after, restorable until then. */
  api.get('/deleted-apps', (c) => {
    const apps = store.all<AppRow>('SELECT * FROM apps WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    return c.json(apps.map((a) => ({ name: a.name, deletedAt: a.deleted_at, purgeAfter: a.purge_after, environments: store.envs(a.id).length })));
  });

  api.post('/deleted-apps/:name/restore', async (c) => {
    const app = store.appByNameAnyState(c.req.param('name'));
    if (!app?.deleted_at) throw fail('not_found_app', `no deleted app named "${c.req.param('name')}"`, 'it may have been purged already');
    restoreApp(ctx, app, ACTOR);
    return c.json(await summaryView(ctx, store.appById(app.id)!));
  });

  api.get('/apps/:id', async (c) => {
    const app = appOf(c);
    return c.json(await detail(app, envOf(c, app)));
  });

  api.delete('/apps/:id', async (c) => {
    await deleteAppNow(ctx, access, appOf(c));
    return c.body(null, 204);
  });

  /** New App key; the old one stops working now. Returns the new prompt once. */
  api.post('/apps/:id/key/rotate', (c) => {
    const app = appOf(c);
    const key = newAppKey();
    store.tx(() => {
      store.run('UPDATE keys SET revoked_at = ? WHERE app_id = ? AND revoked_at IS NULL', now(), app.id);
      store.run('INSERT INTO keys (id, app_id, hash, last4, created_at) VALUES (?, ?, ?, ?, ?)', newId('key'), app.id, sha256hex(key), key.slice(-4), now());
    });
    store.recordActivity(app.id, null, ACTOR, 'key.rotate');
    return c.json({ key, prompt: handoffPrompt(ctx, app.name, key), last4: key.slice(-4) });
  });

  /**
   * "Open app": a one-time link into the env's own origin that signs this browser in to it
   * (replaces GET /console/open/*, a state-changing GET). Body or query `next` = path in the app.
   */
  api.post('/apps/:id/open-ticket', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = c.req.header('content-type')?.includes('json') ? await json(c, z.object({ next: z.string().max(2000).optional() })) : {};
    const { url } = createOpenTicket(ctx, app, env, b.next ?? c.req.query('next'), ACTOR);
    return c.json({ url });
  });

  // ---- environments --------------------------------------------------------

  api.get('/apps/:id/environments', async (c) => c.json(await environmentViews(ctx, appOf(c))));

  api.post('/apps/:id/environments', async (c) => {
    const app = appOf(c);
    const b = await json(c, z.object({ name: z.string(), from: z.string().nullable().optional(), withData: z.boolean().optional() }));
    await cp('POST', `${v1(app)}/envs`, { name: b.name, from: b.from ?? 'main', with_data: b.withData ?? false });
    const views = await environmentViews(ctx, store.appById(app.id)!);
    return c.json(views.find((e) => e.name === b.name), 201);
  });

  api.delete('/apps/:id/environments/:env', async (c) => {
    const app = appOf(c);
    const env = store.envByName(app.id, c.req.param('env'));
    if (!env) throw fail('not_found_env', `no environment "${c.req.param('env')}"`);
    await cp('DELETE', v1(app, env));
    access.deleteEnv(env.id);
    return c.body(null, 204);
  });

  // ---- env operations ------------------------------------------------------

  api.post('/apps/:id/publish', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = await json(c, z.object({ visibility: z.enum(['private', 'org', 'public']) }));
    await cp('PUT', `${v1(app, env)}/access`, { access: b.visibility });
    return c.json(await detail(app, env));
  });

  api.post('/apps/:id/restart', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = await json(c, z.object({ service: z.string().optional() })).catch(() => ({ service: undefined }));
    await cp('POST', `${v1(app, env)}/services/${encodeURIComponent(b.service ?? 'all')}/restart`);
    return c.json(await detail(app, env));
  });

  api.post('/apps/:id/sleep', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    if (!env.box_id) throw fail('conflict', 'nothing is running yet', 'deploy first');
    await ctx.boxlite.stopBox(env.box_id);
    store.recordActivity(app.id, env.name, ACTOR, 'box.sleep');
    return c.json(await detail(app, env));
  });

  /** Rollback = a new deployment of kind rollback, run by the orchestrator like any other. */
  api.post('/apps/:id/releases/:rid/activate', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const to = Number(decodeURIComponent(c.req.param('rid')).replace(/^#/, ''));
    if (!Number.isInteger(to) || to < 1) throw fail('invalid_request', 'release ids look like #7');
    await cp('POST', `${v1(app, env)}/deployments`, { kind: 'rollback', to, message: `Roll back to ${releaseId(to)}` });
    return c.json(await detail(app, env));
  });

  /** One deployment as a timeline: steps with start and duration, every log line, what changed, the classified failure. */
  api.get('/apps/:id/deployments/:n', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const n = Number(c.req.param('n'));
    const d = Number.isInteger(n) ? store.deployment(env.id, n) : undefined;
    if (!d) throw fail('not_found', `no deployment #${c.req.param('n')} in ${env.name}`, 'pick one from the Deployments list');
    const timeline = await cp<Timeline>('GET', `${v1(app, env)}/deployments/${n}/timeline`);
    const release = releaseViews(ctx, app, env, 200).find((r) => r.number === n)!;
    const failure = failureView(ctx, app, env, d);
    return c.json({
      ...release,
      message: d.message,
      specVersion: d.spec_version,
      baseVersion: d.base_version,
      snapshotId: d.snapshot_id,
      rollbackTo: d.kind === 'rollback' ? (d.request.to ?? null) : null,
      timeline: timeline.steps.map((s) => ({ name: s.name, status: s.status, ms: s.ms ?? null, detail: s.detail ?? null, startedAt: s.started_at, finishedAt: s.finished_at })),
      log: timeline.logs.map((l) => ({ id: `l${l.id}`, ts: l.ts, source: l.source, level: l.level === 'error' ? 'error' : l.level === 'warn' ? 'warn' : 'info', line: l.line })),
      logTruncated: timeline.truncated,
      changeSet: deploymentChanges(ctx, app, env, d),
      failure: failure ? { step: failure.step, message: failure.message, ...failure.diagnosis, fixPrompt: failure.fixPrompt } : null,
    });
  });

  api.post('/apps/:id/schedules/:name/run', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const out = await cp<{ name: string; status: number; ms: number; starting: boolean }>('POST', `${v1(app, env)}/schedules/${encodeURIComponent(c.req.param('name'))}/run`);
    return c.json({ ...out, app: await detail(app, env) });
  });

  // ---- volume files: the CLI extras routes (contracts §4.1), in-process -------------

  const filesPath = (c: Context, app: AppRow, env: EnvRow) => {
    const q = new URLSearchParams({ path: c.req.query('path') || '/' });
    if (c.req.query('overwrite') === '1') q.set('overwrite', '1');
    return `${v1(app, env)}/volumes/${encodeURIComponent(c.req.param('name') ?? '')}/files?${q}`;
  };
  /** A directory answers JSON, a file its bytes (as a download). */
  api.get('/apps/:id/volumes/:name/files', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const res = await raw('GET', filesPath(c, app, env));
    if (!res.ok || (res.headers.get('content-type') ?? '').startsWith('application/json')) return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
    const name = (c.req.query('path') ?? '').split('/').filter(Boolean).pop() ?? 'file';
    const headers = new Headers({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"` });
    const size = res.headers.get('x-boxlite-file-size');
    if (size) headers.set('x-boxlite-file-size', size);
    return new Response(res.body, { headers });
  });

  api.put('/apps/:id/volumes/:name/files', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const res = await raw('PUT', filesPath(c, app, env), await c.req.arrayBuffer());
    return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
  });

  api.get('/apps/:id/deployments/:n/source', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const res = await raw('GET', `${v1(app, env)}/deployments/${encodeURIComponent(c.req.param('n'))}/source`);
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  // ---- variables: one save is one apply deployment -------------------------

  /** The manifest behind the latest spec: the request of the deploy/apply that wrote it (rollbacks copy their target). */
  function originOf(env: EnvRow, spec: Spec): Deployment | undefined {
    let d = store.deployment(env.id, spec.deployment);
    for (let i = 0; d && d.kind === 'rollback' && d.request.to && i < 50; i++) d = store.deployment(env.id, d.request.to);
    return d && d.kind !== 'rollback' ? d : undefined;
  }

  function manifestFor(app: AppRow, env: EnvRow, spec: Spec, origin: Deployment | undefined): Manifest {
    const base: Manifest = origin?.request.manifest
      ? structuredClone(origin.request.manifest)
      : {
          app: spec.app,
          environment: spec.environment,
          runtime: spec.runtime,
          services: spec.services,
          schedules: spec.schedules,
          database: spec.database ? { migrations: spec.database.migrations } : null,
          volumes: spec.volumes,
          auth: spec.auth,
          domains: spec.domains,
          access: spec.access,
          variables: spec.variables,
          secrets: spec.secrets,
        };
    return { ...base, app: app.name, environment: env.name, variables: { ...spec.variables }, secrets: { ...spec.secrets } };
  }

  /** The env's migration files with their SQL, so an apply re-records exactly what is applied. */
  async function migrationsFor(app: AppRow, spec: Spec, origin: Deployment | undefined): Promise<MigrationFile[]> {
    if (!spec.database) return [];
    const withSql = origin?.request.migrations?.filter((m) => typeof m.sql === 'string');
    if (withSql?.length) return withSql;
    const listed = origin?.request.resolved_migrations?.length ? origin.request.resolved_migrations : spec.database.applied;
    const out: MigrationFile[] = [];
    for (const m of listed) {
      if (!ctx.blobs.has(app.id, m.sha256)) continue;
      out.push({ file: m.file, sha256: m.sha256, sql: (await buffer(ctx.blobs.read(app.id, m.sha256))).toString('utf8') });
    }
    return out;
  }

  async function applyConfig(app: AppRow, env: EnvRow, message: string, edit: (m: Manifest) => void): Promise<void> {
    const spec = store.spec(env.id);
    if (!spec) throw fail('conflict', 'this environment has no configuration yet', 'variables come from boxlite.toml; your agent creates them with the first apply or deploy');
    const origin = originOf(env, spec);
    const manifest = manifestFor(app, env, spec, origin);
    edit(manifest);
    for (const name of [...Object.keys(manifest.variables), ...Object.keys(manifest.secrets)]) {
      if (!VAR_NAME.test(name)) throw fail('invalid_request', `"${name}" is not a valid variable name`, 'use letters, digits and _');
      if (PLATFORM_VARS.test(name)) throw fail('invalid_request', `${name} is set by BoxLite and cannot be overridden`);
    }
    await cp('POST', `${v1(app, env)}/deployments`, { kind: 'apply', manifest, base_version: spec.version, message, migrations: await migrationsFor(app, spec, origin) });
  }

  const actionSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('setVariable'), name: z.string(), value: z.string() }),
    z.object({ type: z.literal('removeVariable'), name: z.string() }),
    z.object({ type: z.literal('importVariables'), values: z.record(z.string(), z.string()) }),
    z.object({ type: z.literal('referenceSecret'), name: z.string(), from: z.string() }),
    z.object({ type: z.literal('removeSecret'), name: z.string() }),
    z.object({ type: z.literal('createBackup'), message: z.string().max(500).optional() }),
  ]);

  api.post('/apps/:id/actions', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const a = await json(c, actionSchema);
    switch (a.type) {
      case 'setVariable':
        await applyConfig(app, env, `Set ${a.name}`, (m) => {
          delete m.secrets[a.name];
          m.variables[a.name] = a.value;
        });
        break;
      case 'removeVariable':
        await applyConfig(app, env, `Remove ${a.name}`, (m) => {
          if (!(a.name in m.variables)) throw fail('not_found', `no variable ${a.name}`);
          delete m.variables[a.name];
        });
        break;
      case 'importVariables': {
        const names = Object.keys(a.values);
        if (!names.length) throw fail('invalid_request', 'nothing to import');
        await applyConfig(app, env, `Import ${names.length} variable${names.length === 1 ? '' : 's'}`, (m) => {
          for (const [k, v] of Object.entries(a.values)) {
            delete m.secrets[k];
            m.variables[k] = v;
          }
        });
        break;
      }
      case 'referenceSecret':
        if (store.secret(a.from) === undefined) throw fail('not_found', `no org secret "${a.from}"`, 'an org admin sets it first (PUT /admin/secrets/…)');
        await applyConfig(app, env, `Reference ${a.from} as ${a.name}`, (m) => {
          delete m.variables[a.name];
          m.secrets[a.name] = a.from;
        });
        break;
      case 'removeSecret':
        await applyConfig(app, env, `Remove secret ${a.name}`, (m) => {
          if (!(a.name in m.secrets)) throw fail('not_found', `no secret reference ${a.name}`);
          delete m.secrets[a.name];
        });
        break;
      case 'createBackup':
        await cp('POST', `${v1(app, env)}/db/snapshots`, { message: a.message ?? 'Backup from the console' });
        break;
    }
    return c.json(await detail(app, env));
  });

  /** Replaces this env's plain variables and secret references with another env's, as one deployment. */
  api.post('/apps/:id/variables/copy', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = await json(c, z.object({ from: z.string() }));
    const source = store.envByName(app.id, b.from);
    const spec = source ? store.spec(source.id) : undefined;
    if (!source || !spec) throw fail('not_found_env', `environment "${b.from}" has no variables to copy`);
    await applyConfig(app, env, `Copy variables from ${b.from}`, (m) => {
      m.variables = { ...spec.variables };
      m.secrets = { ...spec.secrets };
    });
    return c.json(await detail(app, env));
  });

  api.get('/secrets', async (c) => c.json(await cp<{ name: string; updated_at: string }[]>('GET', '/admin/secrets')));

  // ---- end-user sign-in (Auth tab) ------------------------------------------------

  const authView = async (app: AppRow, env: EnvRow, search?: string) => ({
    status: endUserAuth.authStatus(ctx, app, env),
    users: await endUserAuth.listUsers(ctx, app, env, search),
    // Every sign-in outcome is written to the env's `auth` log source.
    events: store
      .logs(env.id, { source: 'auth', limit: 30 })
      .reverse()
      .map((l) => ({ id: `l${l.id}`, ts: l.ts, level: l.level, line: l.line })),
  });

  api.get('/apps/:id/auth', async (c) => {
    const app = appOf(c);
    return c.json(await authView(app, envOf(c, app), c.req.query('search') || undefined));
  });

  api.get('/apps/:id/users.csv', (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    return c.body(endUserAuth.exportUsersCsv(ctx, app, env), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${app.name}-${env.name}-users.csv"`,
    });
  });

  api.post('/apps/:id/users/:uid/:op{sign-out|block|unblock}', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const uid = c.req.param('uid');
    const op = c.req.param('op');
    if (op === 'sign-out') await endUserAuth.signOutUser(ctx, app, env, uid);
    else if (op === 'block') await endUserAuth.blockUser(ctx, app, env, uid);
    else await endUserAuth.unblockUser(ctx, app, env, uid);
    return c.json(await authView(app, env));
  });

  // ---- logs ------------------------------------------------------------------

  api.get('/apps/:id/logs', (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const since = parseSince(c.req.query('since') || '24h')!;
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 1000) || 1000, 1), 5000);
    const deployment = Number(c.req.query('deployment'));
    const byDeployment = Number.isInteger(deployment) && deployment > 0;
    const lines = store.logs(env.id, { since, limit, ...(byDeployment ? { deployment } : {}) }).map((l) => ({
      id: `l${l.id}`,
      ts: l.ts,
      source: l.source,
      level: l.level === 'error' ? 'error' : 'info',
      line: l.line,
      deployment: l.deployment ?? null,
    }));
    // Visitor requests belong to no deployment.
    const requests = (byDeployment ? [] : access.since(env.id, since, limit)).map((r) => ({
      id: `a${r.id}`,
      ts: r.ts,
      source: 'access',
      level: r.status >= 500 ? 'error' : r.status >= 400 ? 'warn' : 'info',
      line: `${r.method} ${r.path} ${r.status} ${r.ms}ms`,
      deployment: null,
    }));
    const all = [...lines, ...requests].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, limit);
    return c.json(all);
  });

  api.get('/apps/:id/activity', (c) => {
    const app = appOf(c);
    return c.json(activityView(ctx, app, envOf(c, app).name));
  });

  // ---- database -------------------------------------------------------------------

  async function tableCounts(app: AppRow, env: EnvRow): Promise<{ schema: string; name: string; rows: number }[]> {
    const names = (await cp<{ rows: unknown[][] }>('POST', `${v1(app, env)}/db/sql`, { query: TABLES })).rows.map(([name]) => String(name));
    if (!names.length) return [];
    const counts = await cp<{ rows: unknown[][] }>('POST', `${v1(app, env)}/db/sql`, { query: countsQuery(names) });
    const byName = new Map(counts.rows.map(([name, n]) => [String(name), Number(n)]));
    return names.map((name) => ({ schema: 'public', name, rows: byName.get(name) ?? 0 }));
  }

  api.get('/apps/:id/database', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    if (!env.db_url) return c.json({ status: 'none' });
    // Each call opens its own connection (Neon), so they run side by side.
    const [metaResult, tables, migrations, backups] = await Promise.allSettled([
      cp<{ status: string; host?: string; database?: string; user?: string; branch?: string; size_bytes?: number | null }>('GET', `${v1(app, env)}/db`),
      tableCounts(app, env),
      cp<{ file: string; status: string; deployment?: number | null; applied_at?: string }[]>('GET', `${v1(app, env)}/db/migrations`),
      cp<{ id: string; message: string | null; ts: string; by: string }[]>('GET', `${v1(app, env)}/db/snapshots`),
    ]);
    const errors = [metaResult, tables, migrations, backups].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as Error).message);
    const meta = metaResult.status === 'fulfilled' ? metaResult.value : { status: 'unknown' };
    if (meta.status === 'none') return c.json({ status: 'none' });
    return c.json({
      status: meta.status,
      engine: 'Postgres (Neon)',
      host: meta.host,
      name: meta.database,
      user: meta.user,
      branch: meta.branch,
      sizeBytes: meta.size_bytes ?? null,
      tables: tables.status === 'fulfilled' ? tables.value : null,
      migrations: migrations.status === 'fulfilled' ? migrations.value : null,
      backups: backups.status === 'fulfilled' ? backups.value.map((b) => ({ ...b, by: actorLabel(b.by) })) : null,
      restoreWindowHours: RESTORE_WINDOW_HOURS,
      errors,
    });
  });

  api.get('/apps/:id/database/rows/:table', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const table = c.req.param('table');
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 200);
    const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);
    const search = (c.req.query('search') ?? '').trim();
    // Whole-row text match; the literal is escaped for both SQL and LIKE.
    const where = search ? `${quoteIdent(table)}::text ILIKE '%${search.replace(/[\\%_]/g, '\\$&').replace(/'/g, "''")}%'` : '';
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset), ...(where ? { where } : {}) });
    // Each call opens its own database connection, so run them side by side.
    const [page, count, types] = await Promise.all([
      cp<{ columns: string[]; rows: unknown[][] }>('GET', `${v1(app, env)}/db/rows/${encodeURIComponent(table)}?${q}`),
      cp<{ rows: unknown[][] }>('POST', `${v1(app, env)}/db/sql`, { query: `SELECT count(*) FROM public.${quoteIdent(table)}${where ? ` WHERE ${where}` : ''}` }),
      cp<{ rows: unknown[][] }>('POST', `${v1(app, env)}/db/sql`, {
        query: `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table.replace(/'/g, "''")}'`,
      }),
    ]);
    const typeOf = new Map(types.rows.map(([name, type]) => [String(name), String(type)]));
    return c.json({ columns: page.columns, types: page.columns.map((col) => typeOf.get(col) ?? null), rows: cells(page.rows), total: Number(count.rows[0]?.[0] ?? 0), limit, offset });
  });

  api.post('/apps/:id/sql', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = await json(c, z.object({ query: z.string().min(1), write: z.boolean().optional(), explain: z.boolean().optional() }));
    const res = await cp<{ columns: string[]; rows: unknown[][]; row_count: number; elapsed_ms: number; truncated: boolean }>('POST', `${v1(app, env)}/db/sql`, b);
    return c.json({ ...res, rows: cells(res.rows) });
  });

  api.post('/apps/:id/database/restore', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const b = await json(c, z.object({ snapshot: z.string().optional(), to: z.string().optional() }));
    return c.json(await cp('POST', `${v1(app, env)}/db/restore`, b));
  });

  api.all('*', () => {
    throw fail('not_found', 'no such console API route');
  });
  return api;
}
