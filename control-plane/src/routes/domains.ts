import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import { safeEqual } from '../auth.js';
import type { Ctx } from '../ctx.js';
import { addDomain, listDomains, removeDomain, resolveHost, verifyDomain } from '../services/domains.js';
import { body, envOf } from './util.js';

/** `/v1/apps/{app}/envs/{env}/domains…`: an environment's custom domains (services/domains.ts). */
export function domainRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();
  r.get('/envs/:env/domains', (c) => c.json(listDomains(ctx, c.get('app'), envOf(ctx, c))));
  r.post('/envs/:env/domains', async (c) => {
    const b = await body(c, z.object({ host: z.string().min(1).max(253) }));
    return c.json(addDomain(ctx, c.get('app'), envOf(ctx, c), b.host, c.get('actor')), 201);
  });
  r.post('/envs/:env/domains/:host/verify', async (c) => c.json(await verifyDomain(ctx, c.get('app'), envOf(ctx, c), c.req.param('host'), c.get('actor'))));
  r.delete('/envs/:env/domains/:host', (c) => c.json(removeDomain(ctx, c.get('app'), envOf(ctx, c), c.req.param('host'), c.get('actor'))));
  return r;
}

/** `GET /proxy/hosts?host=`: the BoxLite proxy asks which Box and port serve a custom domain (bearer: its resolver token). */
export function proxyHostRoute(ctx: Ctx) {
  const r = new Hono();
  r.get('/hosts', (c) => {
    const token = ctx.config.customDomains?.resolverToken;
    const sent = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token || !safeEqual(sent, token)) return c.json({ error: { code: 'unauthenticated', message: 'resolver token required' } }, 401);
    const target = resolveHost(ctx, c.req.query('host') ?? '');
    return target ? c.json(target) : c.json({ error: { code: 'not_found', message: 'no verified domain with this host' } }, 404);
  });
  return r;
}
