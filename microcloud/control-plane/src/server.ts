import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { PgAppDatabase, pgConnect } from './appdb.js';
import { bindDbReaders } from './dbreader.js';
import { requireAdmin, requireAppKey, type Vars } from './auth.js';
import { BlobStore } from './blobs.js';
import { apiRateLimit } from './limits.js';
import { HttpBoxliteClient } from './boxlite.js';
import type { Config } from './config.js';
import { DEFAULT_TIMING, type Ctx, type Deps, type Timing } from './ctx.js';
import { Store } from './db.js';
import { HttpError, UpstreamError } from './errors.js';
import { EventBus } from './events.js';
import { HttpNeonClient } from './neon.js';
import { mountEndUserAuth } from './enduser/oauth-flow.js';
import { Orchestrator } from './orchestrator.js';
import { Origins, localPortOf } from './origins.js';
import { AccessLog, withAccessLog } from './console-access.js';
import { Resources } from './resources.js';
import { adminRoutes, adminSecretRoutes, appRoutes } from './routes/apps.js';
import { authRoutes } from './routes/auth.js';
import { mountCliExtras } from './routes/cli-extras.js';
import { dbRoutes } from './routes/db.js';
import { deploymentRoutes } from './routes/deployments.js';
import { envRoutes } from './routes/envs.js';
import { logRoutes } from './routes/logs.js';
import { planRoutes } from './routes/plan.js';
import { serveAppOrigin } from './proxy/app-origin.js';
import { legacyRedirect } from './routes/legacy.js';
import { openTicketRoutes } from './routes/open-ticket.js';
import { mountConsole } from './routes/console/index.js';
import { serviceRoutes } from './routes/services.js';
import { svRoutes } from './routes/sv.js';
import { uploadRoutes } from './routes/uploads.js';
import { escapeHtml } from './http/html.js';
import { Scheduler } from './scheduler.js';
import { fail } from './errors.js';
import { deleteApp, purgeApp, restoreApp } from './lifecycle.js';
import { HttpSupervisorClient } from './supervisor.js';
import { envStatus } from './views.js';

export function realDeps(config: Config): Deps {
  return {
    boxlite: new HttpBoxliteClient(config.boxliteApiUrl, config.boxliteApiKey),
    neon: new HttpNeonClient(config.neonApiKey, config.neonOrgId, config.neonRegion),
    supervisor: new HttpSupervisorClient(),
    appdb: new PgAppDatabase(),
  };
}

/** Wires state, clients and workers. Tests pass fake deps and short timings. */
export function buildCtx(config: Config, deps: Deps, timing: Timing = DEFAULT_TIMING): Ctx {
  const store = new Store(join(config.dataDir, 'cp.sqlite'));
  const ctx = { config, store, bus: new EventBus(), blobs: new BlobStore(config.dataDir), timing, ...deps } as Ctx;
  ctx.accessLog = new AccessLog(ctx);
  bindDbReaders(ctx, pgConnect); // F5: reads log in as boxlite_reader (no-op with a fake appdb)
  ctx.origins = new Origins(ctx);
  ctx.resources = new Resources(ctx);
  ctx.orchestrator = new Orchestrator(ctx);
  ctx.scheduler = new Scheduler(ctx);
  return ctx;
}

/** Correlates an error response with its cp.log entry. */
const newRequestId = () => `req_${randomBytes(8).toString('hex')}`;

/** Writes by a key, plus reads of status/context, land in the app's activity log. */
function activityAction(method: string, rest: string): string | null {
  if (method !== 'GET') return `${method} ${rest || '/'}`;
  if (rest === '' || rest === '/') return 'read status';
  if (rest === '/context') return 'read context';
  return null;
}

export function createServer(ctx: Ctx): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.toBody(), err.status as 400);
    // Anything else is the platform's fault, never the caller's. The details (upstream URLs and
    // bodies, SQLite text, stacks) stay in cp.log under an id; the caller gets a fixed message and
    // the id to report. An upstream 403 is the platform's key, not the caller's scope: unavailable.
    const id = newRequestId();
    const where = `${c.req.method} ${new URL(c.req.url).pathname}`;
    if (err instanceof UpstreamError) {
      console.error(`[upstream] ${id} ${where}: ${err.message} (HTTP ${err.status})${err.body ? ` ${err.body.slice(0, 2000)}` : ''}`);
      return c.json(
        { error: { code: 'unavailable', message: `a platform service (${err.service}) did not complete the request`, next: `retry in a minute; if it keeps failing, report error id ${id} to the platform operator`, request_id: id } },
        503,
        { 'x-request-id': id },
      );
    }
    console.error(`[cp] internal ${id} ${where}:`, err);
    return c.json(
      { error: { code: 'internal', message: 'the control plane hit an internal error', next: `retry once; if it fails again, report error id ${id} to the platform operator`, request_id: id } },
      500,
      { 'x-request-id': id },
    );
  });

  // ---- origin roles (origins.ts): the local port decides, never the path or Host ----
  app.use('*', async (c, next) => {
    const role = ctx.origins.roleOf(localPortOf(c));
    // An env's own origin: the app at `/`, plus /.boxlite/open and /.boxlite/auth/*. Nothing else of the CP.
    if (role.kind === 'app') return withAccessLog(ctx.accessLog, role.env, c, () => serveAppOrigin(ctx, c, role.env));
    if (role.kind === 'unassigned') return c.html('<!doctype html><title>Not found</title><h1>No app here</h1>', 404);
    const url = new URL(c.req.url);
    const isConsole = url.pathname === '/console' || url.pathname.startsWith('/console/');
    if (role.kind === 'console') {
      if (url.pathname === '/') return c.redirect('/console/', 302);
      if (!isConsole) return c.json({ error: { code: 'not_found', message: 'the console origin serves only /console', next: `the API is at ${ctx.config.publicUrl}` } }, 404);
      return next();
    }
    // API origin: the console lives on its own origin.
    if (isConsole) return c.redirect(`${ctx.origins.consoleUrl()}${url.pathname}${url.search}`, 302);
    return next();
  });

  app.get('/healthz', (c) => c.text('ok'));
  app.get('/', (c) => c.html(statusPage(ctx)));

  app.get('/agent.md', (c) => {
    if (!existsSync(ctx.config.agentMdPath)) return c.text('agent.md is not available on this control plane', 404);
    const text = readFileSync(ctx.config.agentMdPath, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    return c.body(text, 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' });
  });

  app.get('/cli/boxlite-app.tgz', () => {
    const path = ctx.config.cliTgzPath;
    if (!existsSync(path)) return new Response('CLI package not available', { status: 404 });
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: { 'content-type': 'application/gzip', 'content-length': String(statSync(path).size), 'cache-control': 'no-cache' },
    });
  });

  app.use('/v1/*', apiRateLimit(ctx)); // F8: per-credential token bucket → 429 rate_limited
  // ---- admin -------------------------------------------------------------
  app.use('/v1/apps', async (c, next) => (c.req.method === 'POST' ? requireAdmin(ctx.config.adminToken)(c, next) : next()));
  app.route('/v1', adminRoutes(ctx));
  // Deleting and restoring an App are owner actions, so they take the admin token, not the App key.
  app.delete('/v1/apps/:app', requireAdmin(ctx.config.adminToken), async (c) => {
    const app = ctx.store.appByNameAnyState(c.req.param('app'));
    if (!app) throw fail('not_found_app', `no app named "${c.req.param('app')}"`);
    if (c.req.query('purge') === '1') {
      await purgeApp(ctx, app);
      return c.json({ app: app.name, purged: true });
    }
    return c.json({ app: app.name, ...(await deleteApp(ctx, app, 'admin')) });
  });
  app.post('/v1/apps/:app/restore', requireAdmin(ctx.config.adminToken), (c) => {
    const app = ctx.store.appByNameAnyState(c.req.param('app'));
    if (!app) throw fail('not_found_app', `no app named "${c.req.param('app')}"`, 'it may already have been purged');
    restoreApp(ctx, app, 'admin');
    return c.json({ app: app.name, restored: true });
  });
  app.use('/admin/*', requireAdmin(ctx.config.adminToken));
  app.route('/admin', adminSecretRoutes(ctx));

  // ---- CLI API -----------------------------------------------------------
  const api = new Hono<{ Variables: Vars }>();
  api.use('*', requireAppKey(ctx.store, ctx.config.adminToken));
  api.use('*', async (c, next) => {
    await next();
    if (c.res.status >= 400) return;
    const appName = c.req.param('app');
    const rest = new URL(c.req.url).pathname.slice(`/v1/apps/${appName}`.length);
    const action = activityAction(c.req.method, rest);
    if (!action) return;
    const env = /^\/envs\/([^/]+)/.exec(rest)?.[1] ?? null;
    ctx.store.recordActivity(c.get('app').id, env, c.get('actor'), action);
  });
  for (const sub of [appRoutes, envRoutes, planRoutes, uploadRoutes, deploymentRoutes, serviceRoutes, logRoutes, dbRoutes, authRoutes, openTicketRoutes]) api.route('/', sub(ctx));
  app.route('/v1/apps/:app', api);
  mountCliExtras(app, ctx);

  // ---- supervisor wire ---------------------------------------------------
  app.route('/sv', svRoutes(ctx));

  // ---- sign-in (/auth/*), the console (served on its origin only), old app URLs (last) ----
  mountEndUserAuth(app, ctx);
  mountConsole(app, ctx);
  app.all('*', legacyRedirect(ctx));
  return app;
}

function statusPage(ctx: Ctx): string {
  const rows: string[] = [];
  for (const app of ctx.store.all<{ id: string; name: string }>('SELECT id, name FROM apps WHERE deleted_at IS NULL ORDER BY name')) {
    for (const env of ctx.store.envs(app.id)) {
      const latest = ctx.store.deployments(env.id, 1)[0];
      const url = ctx.resources.appUrl(app.name, env.name);
      rows.push(
        `<tr><td>${escapeHtml(app.name)}</td><td>${escapeHtml(env.name)}</td><td><a href="${escapeHtml(url)}/">${escapeHtml(url)}</a></td><td>${latest ? `#${latest.number} ${latest.kind} ${latest.status}` : '—'}</td><td>${escapeHtml(envStatus(ctx, env))}</td></tr>`,
      );
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>BoxLite Micro-cloud</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#222}table{border-collapse:collapse}td,th{border-bottom:1px solid #ddd;padding:.3rem .8rem;text-align:left}</style></head>
<body><h1>BoxLite Micro-cloud (prototype)</h1><table><tr><th>app</th><th>env</th><th>url</th><th>latest deployment</th><th>status</th></tr>${rows.join('') || '<tr><td colspan="5">no apps yet</td></tr>'}</table></body></html>`;
}
