/** `POST /v1/apps/:app/envs/:env/open-ticket`: a one-time link into the env's origin (what `boxlite-app app open` uses). */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Vars } from '../auth.js';
import type { Ctx } from '../ctx.js';
import { createOpenTicket } from '../proxy/gate.js';
import { body, envOf } from './util.js';

/** `/v1/apps/:app/envs/:env/open-ticket` (App key): what `boxlite-app app open` and agents use. */
export function openTicketRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();
  r.post('/envs/:env/open-ticket', async (c) => {
    const env = envOf(ctx, c);
    const b = c.req.header('content-type')?.includes('json') ? await body(c, z.object({ next: z.string().max(2000).optional() })) : {};
    return c.json(createOpenTicket(ctx, c.get('app'), env, b.next ?? c.req.query('next'), c.get('actor')), 201);
  });
  return r;
}
