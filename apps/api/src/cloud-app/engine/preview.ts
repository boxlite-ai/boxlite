/** Shared PostgreSQL screenshots of an environment's public URL for the dashboard overview. */
import type { Ctx } from './ctx'
import type { AppRow, EnvRow } from './db'
import { now } from './db'
import { recordLogs } from './logsink'
import { createOpenTicket } from './proxy/gate'

export interface PreviewMeta {
  capturedAt: string
  deployment: number
}

const TIMEOUT_MS = 90_000
/** Loading the page, a sleeping Box's wake-up included. */
const LOAD_MS = 60_000
/** After load, how long the page may keep fetching before the picture is taken anyway (pages that poll never go idle). */
const SETTLE_MS = 4_000
/** How long a capture waits for an app behind the "Starting…" page. */
const STARTING_WAIT_MS = 30_000
const STALE_MS = 24 * 3600_000
const VIEWPORT = { width: 1280, height: 800 }

const inFlight = new Set<string>()
/** The last capture that failed, per env, so the console can say why the picture did not change. */
const failures = new Map<string, { at: string; reason: string }>()

/** The env's capture right now: in progress, or the reason the last one failed (null when neither). */
export function previewAttempt(
  envId: string,
): { taking: boolean; failed: { at: string; reason: string } | null } | null {
  const failed = failures.get(envId) ?? null
  return inFlight.has(envId) || failed ? { taking: inFlight.has(envId), failed } : null
}

/** A failure in the words a person needs: what took too long or what went wrong, not a stack. */
function reasonOf(err: Error): string {
  const m = err.message.split('\n')[0]!
  if (/Timeout \d+ms exceeded|timed out/i.test(m)) return `the site took longer than ${LOAD_MS / 1000} s to load`
  if (/still starting/.test(m)) return 'the site was still starting'
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::/.test(m)) return 'the site could not be reached'
  return m.slice(0, 200)
}
let warnedMissing = false

export async function previewMeta(ctx: Pick<Ctx, 'store'>, envId: string): Promise<PreviewMeta | null> {
  const row = await ctx.store.get<{ captured_at: string; deployment: number }>(
    'SELECT captured_at, deployment FROM previews WHERE env_id = ?',
    envId,
  )
  return row ? { capturedAt: row.captured_at, deployment: row.deployment } : null
}
export async function previewImage(ctx: Pick<Ctx, 'store'>, envId: string): Promise<Buffer | null> {
  return (await ctx.store.get<{ image: Buffer }>('SELECT image FROM previews WHERE env_id = ?', envId))?.image ?? null
}
export async function dropPreview(ctx: Pick<Ctx, 'store'>, envId: string): Promise<void> {
  await ctx.store.run('DELETE FROM previews WHERE env_id = ?', envId)
}
/** Captures the env's live URL in the background; never throws, never waits. */
export function capturePreview(ctx: Ctx, appId: string, envId: string, deployment: number): void {
  if (inFlight.has(envId)) return
  const executablePath = ctx.config.chromiumPath
  if (!executablePath) {
    if (!warnedMissing) console.log('[preview] CHROMIUM_PATH is not set; app screenshots are off')
    warnedMissing = true
    return
  }
  inFlight.add(envId)
  void (async () => {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        await capture(ctx, appId, envId, deployment, executablePath),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS)
        }),
      ])
      failures.delete(envId)
    } catch (err) {
      const reason = reasonOf(err as Error)
      failures.set(envId, { at: now(), reason })
      await recordLogs(ctx, envId, [
        {
          ts: now(),
          source: 'system',
          level: 'warn',
          line: `console screenshot of #${deployment} not taken: ${reason}`,
          deployment,
        },
      ])
    } finally {
      clearTimeout(timer)
      inFlight.delete(envId)
    }
  })()
}

/** On view: re-capture a live, awake env whose picture is missing or older than 24 h (never wakes a sleeping Box). */
export async function refreshPreviewIfStale(
  ctx: Ctx,
  app: AppRow,
  env: EnvRow,
  boxState: string | null,
): Promise<void> {
  if (!env.live_deployment || !env.box_id || boxState !== 'running') return
  const meta = await previewMeta(ctx, env.id)
  if (meta && Date.now() - Date.parse(meta.capturedAt) < STALE_MS) return
  capturePreview(ctx, app.id, env.id, env.live_deployment)
}

async function capture(
  ctx: Ctx,
  appId: string,
  envId: string,
  deployment: number,
  executablePath: string,
): Promise<void> {
  const app = await ctx.store.appById(appId)
  const env = await ctx.store.envById(envId)
  if (!app || !env) return
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 })
    // Public envs open directly; others through a one-time ticket that sets the access cookie.
    const url =
      (await ctx.resources.effectiveAccess(env)) === 'public'
        ? (await ctx.resources.appUrl(app.name, env.name)) + '/'
        : (await createOpenTicket(ctx, app, env, '/', 'system')).url
    // Whatever the app shows is the picture, its error pages included: that is what visitors see.
    // The CP's own "Starting…" page is not the app, so wait for the app instead, and keep the old
    // picture if it never finishes starting.
    const deadline = Date.now() + STARTING_WAIT_MS
    let res = await page.goto(url, { waitUntil: 'load', timeout: LOAD_MS })
    while (res?.headers()['x-boxlite-starting'] && Date.now() < deadline) {
      await page.waitForTimeout(3000)
      res = await page.reload({ waitUntil: 'load', timeout: LOAD_MS })
    }
    if (res?.headers()['x-boxlite-starting']) throw new Error('the app was still starting')
    // The platform's own page (not deployed, unavailable, private) is not the app: keep the old picture.
    if (res?.headers()['x-boxlite-page']) throw new Error(`the site showed a ${res.status()} page instead of the app`)
    // Let it fetch its data, but a page that keeps a request open or polls never goes idle.
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => undefined)
    await page.waitForTimeout(500)
    const shot = await page.screenshot({ type: 'jpeg', quality: 72 })
    await ctx.store.run(
      'INSERT INTO previews (env_id,captured_at,deployment,image) VALUES (?,?,?,?) ON CONFLICT(env_id) DO UPDATE SET captured_at=excluded.captured_at,deployment=excluded.deployment,image=excluded.image',
      envId,
      now(),
      deployment,
      shot,
    )
  } finally {
    await browser.close().catch(() => undefined)
  }
}
