/** Console API: browse, download and upload volume files, through the CLI extras routes in-process. */
import type { Context, Hono } from 'hono';
import type { AppRow, EnvRow } from '../../db.js';
import type { ConsoleKit } from './kit.js';

export function consoleVolumeRoutes(api: Hono, k: ConsoleKit): void {
  const { raw, appOf, envOf, v1 } = k;

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
}
