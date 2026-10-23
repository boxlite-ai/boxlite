import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import type { Ctx } from '../ctx.js';
import { authStatus, blockUser, createTestSession, exportUsersCsv, listUsers, redirectUris, signOutUser, unblockUser, purgeTestUsers } from '../enduser/management.js';
import { removeSender, sendMail, senderOf, senderView, setSender } from '../enduser/email-sender.js';
import { fail } from '../errors.js';
import { body, envOf } from './util.js';

/** `/v1/apps/{app}/envs/{env}/auth…`: end-user sign-in status and user management (PRD 3.8); `/auth/email`: the App's mail sender. */
export function authRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();

  r.get('/envs/:env/auth', (c) => c.json(authStatus(ctx, c.get('app'), envOf(ctx, c))));

  r.get('/envs/:env/auth/redirect-uris', (c) => {
    envOf(ctx, c);
    return c.json(redirectUris(ctx));
  });

  r.get('/envs/:env/auth/users', (c) => {
    const limit = c.req.query('limit');
    return c.json(listUsers(ctx, c.get('app'), envOf(ctx, c), { search: c.req.query('search') || undefined, limit: limit ? Number(limit) || undefined : undefined }));
  });

  r.get('/envs/:env/auth/users/export', (c) => {
    const env = envOf(ctx, c);
    return c.body(exportUsersCsv(ctx, c.get('app'), env), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${c.get('app').name}-${env.name}-users.csv"`,
    });
  });

  r.delete('/envs/:env/auth/test-users', async (c) => c.json(await purgeTestUsers(ctx, c.get('app'), envOf(ctx, c), c.get('actor'))));
  r.post('/envs/:env/auth/users/:id/signout', (c) => c.json(signOutUser(ctx, c.get('app'), envOf(ctx, c), c.req.param('id'), c.get('actor'))));
  r.post('/envs/:env/auth/users/:id/block', (c) => c.json(blockUser(ctx, c.get('app'), envOf(ctx, c), c.req.param('id'), c.get('actor'))));
  r.post('/envs/:env/auth/users/:id/unblock', (c) => c.json(unblockUser(ctx, c.get('app'), envOf(ctx, c), c.req.param('id'), c.get('actor'))));

  r.post('/envs/:env/auth/test-sessions', async (c) => {
    const env = envOf(ctx, c);
    const b = await body(c, z.object({ email: z.string().regex(/^[^\s@]+@[^\s@]+$/, 'must be an email address').max(254), role: z.enum(['owner', 'user']).optional() }));
    return c.json(await createTestSession(ctx, c.get('app'), env, b.email, c.get('actor'), b.role), 201);
  });

  // ---- the App's SMTP sender for email code sign-in (docs/email-sign-in.md) ----------------

  r.get('/auth/email', (c) => c.json(senderView(senderOf(ctx, c.get('app')))));

  r.put('/auth/email', async (c) => {
    const b = await body(
      c,
      z.object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535),
        username: z.string().max(320).nullable().optional(),
        password: z.string().max(1024).nullable().optional(),
        from: z.string().min(3).max(320),
      }),
    );
    return c.json(setSender(ctx, c.get('app'), b, c.get('actor')));
  });

  r.delete('/auth/email', (c) => c.json(removeSender(ctx, c.get('app'), c.get('actor'))));

  r.post('/auth/email/test', async (c) => {
    const app = c.get('app');
    const b = await body(c, z.object({ to: z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be an email address').max(254) }));
    const sender = senderOf(ctx, app);
    if (!sender) throw fail('not_found', 'this App has no mail sender yet', 'set one: `printf %s "$PASSWORD" | boxlite-app app auth email set --host <smtp host> --port 587 --username <user> --from <address> --password-stdin`');
    const out = await sendMail(ctx, sender, { to: b.to, subject: `Test email from ${app.name} on BoxLite`, text: `This is a test of the sign-in email sender of ${app.name}. Sign-in codes will come from ${sender.from}.\n` });
    ctx.store.recordActivity(app.id, null, c.get('actor'), 'auth.email.test', { to: b.to });
    return c.json({ sent: true, to: b.to, ms: out.ms });
  });

  return r;
}
