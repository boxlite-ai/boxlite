/** Console API: the Domains tab, an environment's custom domains (services/domains.ts). */
import type { Hono } from 'hono';
import { z } from 'zod';
import { addDomain, removeDomain, verifyDomain } from '../../services/domains.js';
import { actorOf, type ConsoleKit } from './kit.js';

export function consoleDomainRoutes(api: Hono, k: ConsoleKit): void {
  const { ctx, appOf, envOf } = k;

  api.post('/apps/:id/domains', async (c) => {
    const app = appOf(c);
    const b = await k.json(c, z.object({ host: z.string().trim().min(1).max(253) }));
    return c.json(addDomain(ctx, app, envOf(c, app), b.host, actorOf(k.viewer(c))), 201);
  });

  api.post('/apps/:id/domains/:host/verify', async (c) => {
    const app = appOf(c);
    return c.json(await verifyDomain(ctx, app, envOf(c, app), c.req.param('host'), actorOf(k.viewer(c))));
  });

  api.delete('/apps/:id/domains/:host', (c) => {
    const app = appOf(c);
    return c.json(removeDomain(ctx, app, envOf(c, app), c.req.param('host'), actorOf(k.viewer(c))));
  });
}
