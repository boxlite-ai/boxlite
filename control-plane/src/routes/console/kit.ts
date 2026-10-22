/** What every console route group shares: the in-process /v1 client (actor `console`), App/env lookup, the detail view, JSON bodies. */
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { AppDetailView } from '../../console-view-types.js';
import { detailView } from '../../console-views.js';
import type { AppRow, EnvRow } from '../../db.js';
import type { Ctx } from '../../ctx.js';
import { consoleViewer } from '../../console-auth.js';
import { HttpError, fail } from '../../errors.js';
import { canSee, type Viewer } from '../../orgs.js';
import { body, type C } from '../util.js';

export type Cp = <T>(method: string, path: string, json?: unknown) => Promise<T>;
export type Raw = (method: string, path: string, body?: ArrayBuffer) => Promise<Response>;

/** Activity names console actions `console`; `admin` is left for the admin token used directly. */
export const ACTOR = 'console';

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

export interface ConsoleKit {
  ctx: Ctx;
  /** A /v1 or /admin route called in-process as actor `console`, JSON in and out; a CP error is re-thrown unchanged. */
  cp: Cp;
  /** The same, with a raw body and the raw Response. */
  raw: Raw;
  /** The App named by `:id` in the viewer's organization, or not_found_app (also for another org's App). */
  appOf(c: Context): AppRow;
  /** Who is using the console (requireConsoleApi has checked there is someone). */
  viewer(c: Context): Viewer;
  /** The env named by `?env=` (default main), or not_found_env. */
  envOf(c: Context, app: AppRow): EnvRow;
  /** `/v1/apps/<app>[/envs/<env>]`. */
  v1(app: AppRow, env?: EnvRow): string;
  /** The console's app detail view of one env. */
  detail(app: AppRow, env: EnvRow): Promise<AppDetailView>;
  /** The JSON body, checked against `schema` (invalid_request otherwise). */
  json<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>>;
}

export function consoleKit(root: Hono, ctx: Ctx): ConsoleKit {
  const access = ctx.accessLog;
  const { store } = ctx;
  const { call: cp, raw } = cpClient(root, ctx);
  const viewer = (c: Context): Viewer => {
    const v = consoleViewer(ctx, c);
    if (!v) throw fail('unauthenticated', 'sign in to the console first', 'open /console/login');
    return v;
  };
  const appOf = (c: Context): AppRow => {
    const name = c.req.param('id') ?? '';
    const app = store.appByName(name);
    if (!app || !canSee(viewer(c), app)) throw fail('not_found_app', `no app named "${name}"`);
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
  return { ctx, cp, raw, appOf, viewer, envOf, v1, detail, json };
}
