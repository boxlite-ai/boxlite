/** Console API: the Auth tab, end-user sign-in status, users, CSV export, sign out / block / unblock. */
import type { Hono } from 'hono';
import { endUserAuth } from '../../console-enduser.js';
import type { AppRow, EnvRow } from '../../db.js';
import { logLevel } from '../../services/logs.js';
import type { ConsoleKit } from './kit.js';

export function consoleAuthRoutes(api: Hono, k: ConsoleKit): void {
  const { ctx, appOf, envOf } = k;
  const { store } = ctx;

  // ---- end-user sign-in (Auth tab) ------------------------------------------------

  const authView = async (app: AppRow, env: EnvRow, search?: string) => ({
    status: endUserAuth.authStatus(ctx, app, env),
    users: await endUserAuth.listUsers(ctx, app, env, search),
    // Every sign-in outcome is written to the env's `auth` log source.
    events: store
      .logs(env.id, { source: 'auth', limit: 30 })
      .reverse()
      .map((l) => ({ id: `l${l.id}`, ts: l.ts, level: logLevel(l.level), line: l.line })),
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
}
