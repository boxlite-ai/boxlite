/** Console API: the Auth tab, end-user sign-in status, users, CSV export, sign out / block / unblock. */
import type { Hono } from 'hono';
import { endUserAuth } from '../../console-enduser.js';
import type { AppRow, EnvRow } from '../../db.js';
import { logLevel } from '../../services/logs.js';
import { z } from 'zod';
import { now } from '../../db.js';
import { fail } from '../../errors.js';
import { OAUTH_PROVIDERS } from '../../oauth-providers.js';
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

  /**
   * Whose OAuth app signs users in for one provider: BoxLite's ({ keys: 'shared' }) or the App's
   * own ({ keys: 'own', clientId, clientSecret }; the secret may be left out to keep the saved one).
   * For every environment of the App, effective on the next sign-in; no deployment needed.
   */
  api.put('/apps/:id/auth/methods/:provider', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const provider = c.req.param('provider');
    if (!OAUTH_PROVIDERS[provider]) throw fail('not_found', `no sign-in provider "${provider}"`, `one of: ${Object.keys(OAUTH_PROVIDERS).join(', ')}`);
    const b = await k.json(
      c,
      z.discriminatedUnion('keys', [
        z.object({ keys: z.literal('shared') }),
        z.object({ keys: z.literal('own'), clientId: z.string().trim().min(4).max(200), clientSecret: z.string().trim().min(4).max(400).optional() }),
      ]),
    );
    if (b.keys === 'shared') {
      store.run('DELETE FROM app_oauth_clients WHERE app_id = ? AND provider = ?', app.id, provider);
    } else {
      const saved = store.get<{ client_secret: string }>('SELECT client_secret FROM app_oauth_clients WHERE app_id = ? AND provider = ?', app.id, provider);
      const secret = b.clientSecret ?? saved?.client_secret;
      if (!secret) throw fail('invalid_request', 'the client secret is required', `paste the client secret of your ${provider} OAuth app`);
      store.run(
        'INSERT INTO app_oauth_clients (app_id, provider, client_id, client_secret, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id, provider) DO UPDATE SET client_id = excluded.client_id, client_secret = excluded.client_secret, updated_at = excluded.updated_at',
        app.id,
        provider,
        b.clientId,
        secret,
        now(),
      );
    }
    return c.json(await authView(app, env));
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
