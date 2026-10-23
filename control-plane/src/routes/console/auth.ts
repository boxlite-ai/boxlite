/** Console API: the Auth tab, end-user sign-in status, users, CSV export, sign out / block / unblock. */
import type { Hono } from 'hono';
import { endUserAuth } from '../../console-enduser.js';
import type { AppRow, EnvRow } from '../../db.js';
import { logLevel } from '../../services/logs.js';
import { z } from 'zod';
import { now } from '../../db.js';
import { fail } from '../../errors.js';
import { OAUTH_PROVIDERS, appleKeyOf } from '../../oauth-providers.js';
import { removeSender, sendMail, senderOf, setSender } from '../../enduser/email-sender.js';
import { actorOf, type ConsoleKit } from './kit.js';

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

  // ---- the App's mail sender for email code sign-in (docs/email-sign-in.md) -------------

  api.put('/apps/:id/auth/email', async (c) => {
    const app = appOf(c);
    const b = await k.json(
      c,
      z.object({
        host: z.string().trim().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        username: z.string().trim().max(320).nullable().optional(),
        // Left out: keep the saved password.
        password: z.string().max(1024).optional(),
        from: z.string().trim().min(3).max(320),
      }),
    );
    setSender(ctx, app, b, actorOf(k.viewer(c)));
    return c.json(await authView(app, envOf(c, app)));
  });

  api.delete('/apps/:id/auth/email', async (c) => {
    const app = appOf(c);
    removeSender(ctx, app, actorOf(k.viewer(c)));
    return c.json(await authView(app, envOf(c, app)));
  });

  api.post('/apps/:id/auth/email/test', async (c) => {
    const app = appOf(c);
    const b = await k.json(c, z.object({ to: z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address').max(254) }));
    const sender = senderOf(ctx, app);
    if (!sender) throw fail('not_found', 'this App has no mail sender yet', 'set it up first');
    const out = await sendMail(ctx, sender, { to: b.to, subject: `Test email from ${app.name} on BoxLite`, text: `This is a test of the sign-in email sender of ${app.name}. Sign-in codes will come from ${sender.from}.\n` });
    store.recordActivity(app.id, null, actorOf(k.viewer(c)), 'auth.email.test', { to: b.to });
    return c.json({ sent: true, to: b.to, ms: out.ms });
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
        z.object({
          keys: z.literal('own'),
          clientId: z.string().trim().min(4).max(200),
          clientSecret: z.string().trim().min(4).max(400).optional(),
          // Apple: the .p8 key is the secret; its Team ID and Key ID go with it.
          // Lengths are checked by appleSecret, in words a person can act on.
          teamId: z.string().trim().min(1).max(40).optional(),
          keyId: z.string().trim().min(1).max(40).optional(),
          privateKey: z.string().trim().min(1).max(4000).optional(),
        }),
      ]),
    );
    if (b.keys === 'shared' && OAUTH_PROVIDERS[provider]!.ownKeysOnly) {
      throw fail('invalid_request', `BoxLite runs no ${OAUTH_PROVIDERS[provider]!.label} OAuth app`, 'add your own OAuth app, or turn the method off');
    }
    if (b.keys === 'shared') {
      store.run('DELETE FROM app_oauth_clients WHERE app_id = ? AND provider = ?', app.id, provider);
    } else {
      const saved = store.get<{ client_secret: string }>('SELECT client_secret FROM app_oauth_clients WHERE app_id = ? AND provider = ?', app.id, provider);
      const secret = provider === 'apple' ? appleSecret(b, saved?.client_secret) : (b.clientSecret ?? saved?.client_secret);
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

/** Apple's three values, stored as one secret; any left out keeps its saved value. */
function appleSecret(b: { teamId?: string; keyId?: string; privateKey?: string }, saved: string | undefined): string | undefined {
  const old = saved ? appleKeyOf(saved) : null;
  const key = { teamId: b.teamId ?? old?.teamId, keyId: b.keyId ?? old?.keyId, privateKey: b.privateKey ?? old?.privateKey };
  if (!key.teamId || !key.keyId || !key.privateKey) throw fail('invalid_request', 'Apple needs the Team ID, the Key ID and the private key (.p8)', 'all three are in your Apple Developer account, under Certificates, Identifiers & Profiles › Keys');
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(key.privateKey)) throw fail('invalid_request', 'the private key is not a .p8 file', 'paste the whole file, BEGIN and END lines included');
  return JSON.stringify(key);
}
