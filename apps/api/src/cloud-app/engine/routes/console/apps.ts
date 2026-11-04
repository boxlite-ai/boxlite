/** Console API: the App list, create/delete/restore, key rotation, Open app, environments, and env operations (visibility, restart, sleep, run a schedule). */
import type { Hono } from 'hono'
import { z } from 'zod'
import { environmentViews, summaryView } from '../../console-views'
import { handoffPrompt } from '../../console-prompt'
import { fail } from '../../errors'
import { deleteApp, restoreApp } from '../../lifecycle'
import { capturePreview, previewImage } from '../../preview'
import { createOpenTicket } from '../../proxy/gate'
import { createApp, issueKey, listKeys, revokeKey, rotateKey } from '../../services/apps'
import { canSee, orgIdFor } from '../../orgs'
import { actorOf, type ConsoleKit } from './kit'

export function consoleAppRoutes(api: Hono, k: ConsoleKit): void {
  const { ctx, cp, appOf, viewer, envOf, v1, detail, json } = k
  const { store } = ctx

  // ---- apps ----------------------------------------------------------------

  api.get('/apps', async (c) => {
    const v = viewer(c)
    return c.json(
      await Promise.all((await store.apps()).filter((a) => canSee(v, a)).map(async (a) => await summaryView(ctx, a))),
    )
  })

  /** The credential is issued by the platform and returned once. */
  api.post('/apps', async (c) => {
    const b = await json(c, z.object({ name: z.string().trim().min(1).max(64) }))
    const v = viewer(c)
    const { app, key } = await createApp(ctx, b.name, actorOf(v), orgIdFor(v))
    const env = (await store.envByName(app.id, 'main'))!
    return c.json({ app: await detail(app, env), key, prompt: handoffPrompt(ctx, app.name, key) }, 201)
  })

  /** Soft-deleted apps (PRD 3.13): kept until purge_after, restorable until then. */
  api.get('/apps/deleted', async (c) => {
    const v = viewer(c)
    return c.json(
      await Promise.all(
        (await store.deletedApps())
          .filter((a) => canSee(v, a))
          .map(async (a) => ({
            name: a.name,
            deletedAt: a.deleted_at,
            purgeAfter: a.purge_after,
            environments: (await store.envs(a.id)).length,
          })),
      ),
    )
  })

  api.post('/apps/deleted/:name/restore', async (c) => {
    const app = await store.appByNameAnyState(c.req.param('name'))
    if (!app?.deleted_at || !canSee(viewer(c), app))
      throw fail('not_found_app', `no deleted app named "${c.req.param('name')}"`, 'it may have been purged already')
    await restoreApp(ctx, app, actorOf(viewer(c)))
    return c.json(await summaryView(ctx, (await store.appById(app.id))!))
  })

  api.get('/apps/:id/view', async (c) => {
    const app = await appOf(c)
    return c.json(await detail(app, await envOf(c, app)))
  })

  /** The last screenshot of the env's live URL (preview.ts), for the Overview. */
  api.get('/apps/:id/preview', async (c) => {
    const app = await appOf(c)
    const env = await envOf(c, app)
    const image = await previewImage(ctx, env.id)
    if (!image)
      throw fail(
        'not_found',
        `no screenshot of ${app.name} · ${env.name} yet`,
        'one is taken when a deployment goes live',
      )
    return c.body(new Uint8Array(image), 200, {
      'content-type': 'image/jpeg',
      'cache-control': 'private, max-age=86400',
    })
  })

  /** A new screenshot now (it wakes a sleeping app, as a visitor would); taken in the background. */
  api.post('/apps/:id/preview', async (c) => {
    const app = await appOf(c)
    const env = await envOf(c, app)
    if (!env.live_deployment) throw fail('conflict', `${app.name} · ${env.name} has nothing live to take a picture of`)
    capturePreview(ctx, app.id, env.id, env.live_deployment)
    return c.json({ capturing: true }, 202)
  })

  /** Delete is the soft delete of PRD 3.13; the purger removes the resources later. */
  api.delete('/apps/:id', async (c) => {
    await deleteApp(ctx, await appOf(c), actorOf(viewer(c)))
    return c.body(null, 204)
  })

  /** One more App key next to the active ones (another agent or machine); returns its prompt once. */
  api.post('/apps/:id/key/issue', async (c) => {
    const app = await appOf(c)
    const key = await issueKey(ctx, app, actorOf(viewer(c)))
    return c.json({
      key,
      prompt: handoffPrompt(ctx, app.name, key, undefined, (await envOf(c, app)).name),
      last4: key.slice(-4),
    })
  })

  /** The active App keys (last 4 characters, made, last used), for revoking one at a time. */
  api.get('/apps/:id/keys', async (c) => c.json(await listKeys(ctx, await appOf(c))))

  api.delete('/apps/:id/keys/:keyId', async (c) => {
    await revokeKey(ctx, await appOf(c), c.req.param('keyId'), actorOf(viewer(c)))
    return c.body(null, 204)
  })

  /** New App key; the old one stops working now. Returns the new prompt once. */
  api.post('/apps/:id/key/rotate', async (c) => {
    const app = await appOf(c)
    const key = await rotateKey(ctx, app, actorOf(viewer(c)))
    return c.json({
      key,
      prompt: handoffPrompt(ctx, app.name, key, undefined, (await envOf(c, app)).name),
      last4: key.slice(-4),
    })
  })

  /**
   * "Open app": a one-time link into the env's own origin that signs this browser in to it
   * Body or query `next` is the path in the app.
   */
  api.post('/apps/:id/open-ticket', async (c) => {
    const app = await appOf(c)
    const env = await envOf(c, app)
    const b = c.req.header('content-type')?.includes('json')
      ? await json(c, z.object({ next: z.string().max(2000).optional() }))
      : {}
    const { url } = await createOpenTicket(ctx, app, env, b.next ?? c.req.query('next'), actorOf(viewer(c)))
    return c.json({ url })
  })

  // ---- environments --------------------------------------------------------

  api.get('/apps/:id/environments', async (c) => c.json(await environmentViews(ctx, await appOf(c))))

  api.post('/apps/:id/environments', async (c) => {
    const app = await appOf(c)
    const b = await json(
      c,
      z.object({ name: z.string(), from: z.string().nullable().optional(), withData: z.boolean().optional() }),
    )
    await cp('POST', `${v1(app)}/envs`, { name: b.name, from: b.from ?? 'main', with_data: b.withData ?? false })
    const views = await environmentViews(ctx, (await store.appById(app.id))!)
    return c.json(
      views.find((e) => e.name === b.name),
      201,
    )
  })

  api.delete('/apps/:id/environments/:env', async (c) => {
    const app = await appOf(c)
    const env = await store.envByName(app.id, c.req.param('env'))
    if (!env) throw fail('not_found_env', `no environment "${c.req.param('env')}"`)
    await cp('DELETE', v1(app, env))
    return c.body(null, 204)
  })

  // ---- env operations ------------------------------------------------------

  api.post('/apps/:id/publish', async (c) => {
    const app = await appOf(c)
    const env = await envOf(c, app)
    const b = await json(c, z.object({ visibility: z.enum(['private', 'org', 'public']) }))
    await cp('PUT', `${v1(app, env)}/access`, { access: b.visibility })
    return c.json(await detail(app, env))
  })

  api.post('/apps/:id/restart', async (c) => {
    const app = await appOf(c)
    const env = await envOf(c, app)
    const b = await json(c, z.object({ service: z.string().optional() })).catch(() => ({ service: undefined }))
    await cp('POST', `${v1(app, env)}/services/${encodeURIComponent(b.service ?? 'all')}/restart`)
    return c.json(await detail(app, env))
  })

  api.post('/apps/:id/sleep', async (c) => {
    const app = await appOf(c)
    const env = await envOf(c, app)
    if (!env.box_id) throw fail('conflict', 'nothing is running yet', 'deploy first')
    await ctx.resources.sleep(env.box_id)
    await store.recordActivity(app.id, env.name, actorOf(viewer(c)), 'box.sleep')
    return c.json(await detail(app, env))
  })

  api.post('/apps/:id/schedules/:name/run', async (c) => {
    const app = await appOf(c)
    const env = await envOf(c, app)
    const out = await cp<{ name: string; status: number; ms: number; starting: boolean }>(
      'POST',
      `${v1(app, env)}/schedules/${encodeURIComponent(c.req.param('name'))}/run`,
    )
    return c.json({ ...out, app: await detail(app, env) })
  })
}
