import { Hono } from 'hono'
import { z } from 'zod'
import { newId, newSecret, type Vars } from '../auth'
import { ACTIVE_STATUSES, now } from '../db'
import type { Ctx } from '../ctx'
import { fail } from '../errors'
import { nameProblem } from '../platform'
import { dropPreview } from '../preview'
import { envSummary } from '../views'
import { body, envOf } from './util'

export function envRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>()
  const { store } = ctx

  r.get('/envs', async (c) => {
    const app = c.get('app')
    return c.json(await Promise.all((await store.envs(app.id)).map(async (e) => await envSummary(ctx, app, e))))
  })

  r.post('/envs', async (c) => {
    const app = c.get('app')
    const b = await body(
      c,
      z.object({ name: z.string(), from: z.string().optional(), with_data: z.boolean().optional() }),
    )
    const problem = nameProblem(b.name)
    if (problem) throw fail('invalid_request', `env name "${b.name}" ${problem}`)
    if (await store.envByName(app.id, b.name))
      throw fail('conflict', `env "${b.name}" already exists`, `use it with \`--env ${b.name}\`, or pick another name`)
    const from = b.from ?? 'main'
    if (!(await store.envByName(app.id, from))) throw fail('not_found_env', `no environment "${from}" to branch from`)
    const id = newId('env')
    await store.run(
      'INSERT INTO envs (id, app_id, name, created_at, from_env, with_data, forward_secret, control_secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      app.id,
      b.name,
      now(),
      from,
      b.with_data ? 1 : 0,
      newSecret(),
      newSecret(),
    )
    // The database branch is created now if the app already has a Neon project; otherwise on the
    // env's first apply/deploy that declares [database].
    if (app.neon_project_id) {
      try {
        await ctx.resources.ensureDatabase(app.id, id)
      } catch (err) {
        await store.run('DELETE FROM envs WHERE id = ?', id)
        throw err
      }
    }
    return c.json(await envSummary(ctx, (await store.appById(app.id))!, (await store.envById(id))!), 201)
  })

  r.get('/envs/:env', async (c) => {
    const env = await envOf(ctx, c)
    return c.json(await envSummary(ctx, c.get('app'), env))
  })

  r.delete('/envs/:env', async (c) => {
    const app = c.get('app')
    const env = await envOf(ctx, c)
    if (env.name === 'main') throw fail('forbidden', 'the main environment cannot be deleted')
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',')
    if (
      (await store.deploymentsWhere(`env_id = ? AND status IN (${placeholders})`, env.id, ...ACTIVE_STATUSES)).length
    ) {
      throw fail('conflict', `env "${env.name}" has a deployment in progress`, 'cancel it or wait for it to finish')
    }
    if (env.box_id) await ctx.boxlite.deleteBox(env.box_id)
    await ctx.resources.deleteVolumes(app, env)
    if (env.neon_branch_id && app.neon_project_id && env.neon_branch_id !== app.neon_main_branch_id) {
      await ctx.neon.deleteBranch(app.neon_project_id, env.neon_branch_id)
    }
    await ctx.domains.releaseEnvironment(app, env)
    await store.tx(async () => {
      await store.run('DELETE FROM deployment_events WHERE env_id = ?', env.id)
      await store.run('DELETE FROM logs WHERE env_id = ?', env.id)
      await store.run('DELETE FROM envs WHERE id = ?', env.id)
    })
    await dropPreview(ctx, env.id)
    return c.json({ deleted: env.name })
  })

  r.get('/envs/:env/spec', async (c) => {
    const env = await envOf(ctx, c)
    const v = c.req.query('version')
    const spec = await store.spec(env.id, v ? Number(v) : undefined)
    if (!spec)
      throw fail(
        'not_found',
        v ? `no spec version ${v}` : 'no spec yet',
        'run `boxlite-app apply --yes` or `boxlite-app deploy` first',
      )
    return c.json(spec)
  })

  return r
}
