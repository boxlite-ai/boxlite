import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import type { Ctx } from '../ctx.js';
import { authStatus, blockUser, createTestSession, exportUsersCsv, listUsers, redirectUris, signOutUser, unblockUser } from '../enduser-auth.js';
import { body, envOf } from './util.js';

/** `/v1/apps/{app}/envs/{env}/auth…`: end-user sign-in status and user management (PRD 3.8). */
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

  r.post('/envs/:env/auth/users/:id/signout', (c) => c.json(signOutUser(ctx, c.get('app'), envOf(ctx, c), c.req.param('id'), c.get('actor'))));
  r.post('/envs/:env/auth/users/:id/block', (c) => c.json(blockUser(ctx, c.get('app'), envOf(ctx, c), c.req.param('id'), c.get('actor'))));
  r.post('/envs/:env/auth/users/:id/unblock', (c) => c.json(unblockUser(ctx, c.get('app'), envOf(ctx, c), c.req.param('id'), c.get('actor'))));

  r.post('/envs/:env/auth/test-sessions', async (c) => {
    const env = envOf(ctx, c);
    const b = await body(c, z.object({ email: z.string().regex(/^[^\s@]+@[^\s@]+$/, 'must be an email address').max(254) }));
    return c.json(await createTestSession(ctx, c.get('app'), env, b.email, c.get('actor')), 201);
  });

  return r;
}
