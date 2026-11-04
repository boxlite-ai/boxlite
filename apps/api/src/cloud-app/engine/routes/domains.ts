import { Hono } from 'hono'
import { z } from 'zod'
import type { Vars } from '../auth'
import { safeEqual } from '../auth'
import type { Ctx } from '../ctx'
import { addDomain, listDomains, removeDomain, verifyDomain } from '../services/domains'
import { body, envOf } from './util'

/** `/v1/apps/{app}/envs/{env}/domains…`: an environment's custom domains (services/domains.ts). */
export function domainRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>()
  r.get('/envs/:env/domains', async (c) => c.json(await listDomains(ctx, c.get('app'), await envOf(ctx, c))))
  r.post('/envs/:env/domains', async (c) => {
    const b = await body(c, z.object({ host: z.string().min(1).max(253) }))
    return c.json(await addDomain(ctx, c.get('app'), await envOf(ctx, c), b.host, c.get('actor')), 201)
  })
  r.post('/envs/:env/domains/:host/verify', async (c) =>
    c.json(await verifyDomain(ctx, c.get('app'), await envOf(ctx, c), c.req.param('host'), c.get('actor'))),
  )
  r.delete('/envs/:env/domains/:host', async (c) =>
    c.json(await removeDomain(ctx, c.get('app'), await envOf(ctx, c), c.req.param('host'), c.get('actor'))),
  )
  return r
}
