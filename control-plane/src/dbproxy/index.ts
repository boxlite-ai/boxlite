/**
 * `GET /v1/apps/{app}/envs/{env}/db/connect` (WebSocket, API origin only): the CP end of
 * `boxlite-app app db proxy`. Authenticated by the App key like every /v1 route; `?write=1`
 * logs in as the database owner, otherwise as boxlite_reader. One WebSocket carries one Postgres
 * connection (session.ts). The database password never leaves the CP.
 *
 * Activity: one row per proxy run (the CLI names it with `X-BoxLite-Proxy-Session`), action
 * `db.proxy`, detail `{role, session, started_at, ended_at, duration_ms, connections, open,
 * statements, refused}`, updated as its connections open and close.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { appForKey, bearer, safeEqual } from '../auth.js';
import type { Ctx } from '../ctx.js';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import { runSession } from './session.js';
import { acceptWebSocket, refuseUpgrade } from './websocket.js';

const PATH = /^\/v1\/apps\/([^/]+)\/envs\/([^/]+)\/db\/connect$/;
/** Open proxied connections per env (a local ORM pool is ~10). */
export const MAX_CONNECTIONS_PER_ENV = 20;
/** A proxy run's Activity row stops being updated this long after its last connection closed. */
const SESSION_LINGER_MS = 10 * 60_000;

interface ProxyRun {
  activityId: number;
  started: number;
  open: number;
  connections: number;
  statements: number;
  refused: number;
  timer?: NodeJS.Timeout;
}

const runs = new Map<string, ProxyRun>();
const openPerEnv = new Map<string, number>();

const error = (code: string, message: string, next: string) => ({ error: { code, message, next } });

function record(ctx: Ctx, run: ProxyRun, detail: Record<string, unknown>): void {
  ctx.store.run('UPDATE activity SET detail = ? WHERE id = ?', JSON.stringify(detail), run.activityId);
}

/** Opens (or joins) the Activity row of a proxy run and returns the per-connection callbacks. */
function track(ctx: Ctx, app: AppRow, env: EnvRow, actor: string, role: 'reader' | 'owner', session: string) {
  const key = `${app.id}/${env.id}/${actor}/${role}/${session}`;
  const envKey = env.id;
  const detail = (run: ProxyRun) => ({
    role,
    session,
    started_at: new Date(run.started).toISOString(),
    ended_at: run.open ? null : now(),
    duration_ms: Date.now() - run.started,
    connections: run.connections,
    open: run.open,
    statements: run.statements,
    refused: run.refused,
  });
  return {
    onOpen() {
      let run = runs.get(key);
      if (!run) {
        const started = Date.now();
        ctx.store.recordActivity(app.id, env.name, actor, 'db.proxy', { role, session, started_at: new Date(started).toISOString() });
        const row = ctx.store.get<{ id: number }>('SELECT id FROM activity WHERE app_id = ? AND action = ? ORDER BY id DESC LIMIT 1', app.id, 'db.proxy')!;
        run = { activityId: row.id, started, open: 0, connections: 0, statements: 0, refused: 0 };
        runs.set(key, run);
        console.log(`[db-proxy] ${app.name}/${env.name} ${role} session ${session} opened by ${actor}`);
      }
      if (run.timer) clearTimeout(run.timer);
      run.open++;
      run.connections++;
      record(ctx, run, detail(run));
    },
    onClose(stats: { statements: number; refused: number }) {
      openPerEnv.set(envKey, Math.max(0, (openPerEnv.get(envKey) ?? 1) - 1));
      const run = runs.get(key);
      if (!run) return;
      run.open--;
      run.statements += stats.statements;
      run.refused += stats.refused;
      record(ctx, run, detail(run));
      if (!run.open) {
        run.timer = setTimeout(() => runs.delete(key), SESSION_LINGER_MS);
        run.timer.unref();
      }
    },
    /** A connection that never reached the database still frees its slot. */
    release() {
      openPerEnv.set(envKey, Math.max(0, (openPerEnv.get(envKey) ?? 1) - 1));
    },
  };
}

/**
 * Handles the upgrade if it is a db/connect on the API origin; returns null for every other
 * upgrade (the app-origin WebSocket proxy takes those).
 */
export function handleDbConnect(ctx: Ctx, req: IncomingMessage, socket: Duplex, head: Buffer, localPort: number): Promise<void> | null {
  const url = new URL(req.url ?? '/', 'http://cp.local');
  const m = PATH.exec(url.pathname);
  if (!m || ctx.origins.roleOf(localPort).kind !== 'api') return null;
  return (async () => {
    const [appName, envName] = [decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)];
    const token = bearer(req.headers.authorization);
    if (!token) return refuseUpgrade(socket, 401, error('unauthenticated', 'missing App key', 'send Authorization: Bearer <App key> (bxl_app_…)'));
    let app: AppRow | undefined;
    let actor: string;
    if (safeEqual(token, ctx.config.adminToken)) {
      app = ctx.store.appByName(appName);
      actor = 'admin';
    } else {
      const found = appForKey(ctx.store, token);
      if (!found) return refuseUpgrade(socket, 401, error('unauthenticated', 'App key not recognised', 'check BOXLITE_API_KEY; `boxlite-app whoami` tests it'));
      if (found.app.name !== appName) return refuseUpgrade(socket, 403, error('forbidden', `this App key belongs to "${found.app.name}", not "${appName}"`, '`boxlite-app whoami`'));
      app = found.app;
      actor = `key:…${found.last4}`;
    }
    if (!app) return refuseUpgrade(socket, 404, error('not_found_app', `no app named "${appName}"`, '`boxlite-app whoami`'));
    const env = ctx.store.envByName(app.id, envName);
    if (!env) return refuseUpgrade(socket, 404, error('not_found_env', `no environment "${envName}" in app "${app.name}"`, '`boxlite-app app status` lists the environments'));
    const ownerUrl = env.db_url;
    if (!ownerUrl) return refuseUpgrade(socket, 404, error('not_found', `env "${env.name}" has no database`, 'add [database] to boxlite.toml and run `boxlite-app apply --yes`'));
    const appdb = ctx.appdb;
    if (!appdb.loginUrl) return refuseUpgrade(socket, 503, error('unavailable', 'this control plane has no database login for the proxy', 'tell the user the platform operator must configure the database service'));
    const open = openPerEnv.get(env.id) ?? 0;
    if (open >= MAX_CONNECTIONS_PER_ENV) return refuseUpgrade(socket, 429, error('rate_limited', `${MAX_CONNECTIONS_PER_ENV} proxied connections to ${app.name}/${env.name} are open already`, 'close some (a local connection pool holds several), then reconnect'));
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    openPerEnv.set(env.id, open + 1);
    const write = url.searchParams.get('write') === '1';
    const header = req.headers['x-boxlite-proxy-session'];
    const session = typeof header === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(header) ? header : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const t = track(ctx, app, env, actor, write ? 'owner' : 'reader', session);
    let reached = false;
    ws.on('close', () => {
      if (!reached) t.release();
    });
    runSession(ws, {
      appId: app.id,
      write,
      main: env.name === 'main',
      login: (refresh) => appdb.loginUrl!(ownerUrl, write ? 'owner' : 'reader', { refresh }),
      onOpen: () => {
        reached = true;
        t.onOpen();
      },
      onClose: (stats) => t.onClose(stats),
    });
  })();
}
