/**
 * Screenshots of an env's live URL for the console's Overview (the picture beside the URL).
 *
 * After every deployment goes live (orchestrator.ts finishLive), and when the console views an env
 * whose picture is older than 24 h while its Box is running, the CP renders the env's own origin in
 * headless Chromium and keeps one JPEG per env in DATA_DIR/previews/<env id>.jpg, with
 * <env id>.json = { capturedAt, deployment }. The console reads it through
 * GET /console/api/apps/:id/preview?env=.
 *
 * Private and org envs are opened the way the console's "Open app" opens them: a one-time ticket
 * sets the env's access cookie, so no key or token ever travels in a header to the app or to the
 * hosts its page loads from. A capture never blocks or fails a deployment: it runs in the
 * background, one at a time per env, under a hard timeout, and a failure is one `system` log line.
 *
 * Chromium comes from CHROMIUM_PATH (deploy/deploy-cp.sh installs it in the CP Box); playwright-core
 * is loaded lazily, so a CP without either still runs and simply has no pictures.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from './ctx.js';
import type { AppRow, EnvRow } from './db.js';
import { now } from './db.js';
import { recordLogs } from './logsink.js';
import { createOpenTicket } from './proxy/gate.js';

export interface PreviewMeta {
  capturedAt: string;
  deployment: number;
}

const TIMEOUT_MS = 90_000;
/** Loading the page, a sleeping Box's wake-up included. */
const LOAD_MS = 60_000;
/** After load, how long the page may keep fetching before the picture is taken anyway (pages that poll never go idle). */
const SETTLE_MS = 4_000;
/** How long a capture waits for an app behind the "Starting…" page. */
const STARTING_WAIT_MS = 30_000;
const STALE_MS = 24 * 3600_000;
const VIEWPORT = { width: 1280, height: 800 };

const inFlight = new Set<string>();
/** The last capture that failed, per env, so the console can say why the picture did not change. */
const failures = new Map<string, { at: string; reason: string }>();

/** The env's capture right now: in progress, or the reason the last one failed (null when neither). */
export function previewAttempt(envId: string): { taking: boolean; failed: { at: string; reason: string } | null } | null {
  const failed = failures.get(envId) ?? null;
  return inFlight.has(envId) || failed ? { taking: inFlight.has(envId), failed } : null;
}

/** A failure in the words a person needs: what took too long or what went wrong, not a stack. */
function reasonOf(err: Error): string {
  const m = err.message.split('\n')[0]!;
  if (/Timeout \d+ms exceeded|timed out/i.test(m)) return `the site took longer than ${LOAD_MS / 1000} s to load`;
  if (/still starting/.test(m)) return 'the site was still starting';
  if (/ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::/.test(m)) return 'the site could not be reached';
  return m.slice(0, 200);
}
let warnedMissing = false;

const dir = (ctx: Pick<Ctx, 'config'>) => join(ctx.config.dataDir, 'previews');
const imagePath = (ctx: Pick<Ctx, 'config'>, envId: string) => join(dir(ctx), `${envId}.jpg`);
const metaPath = (ctx: Pick<Ctx, 'config'>, envId: string) => join(dir(ctx), `${envId}.json`);

export function previewMeta(ctx: Pick<Ctx, 'config'>, envId: string): PreviewMeta | null {
  try {
    if (!existsSync(imagePath(ctx, envId))) return null;
    return JSON.parse(readFileSync(metaPath(ctx, envId), 'utf8')) as PreviewMeta;
  } catch {
    return null;
  }
}

/** The JPEG of the env's last capture, or null. */
export function previewImage(ctx: Pick<Ctx, 'config'>, envId: string): Buffer | null {
  try {
    return readFileSync(imagePath(ctx, envId));
  } catch {
    return null;
  }
}

/** Forgets an env's picture (env deleted). */
export function dropPreview(ctx: Pick<Ctx, 'config'>, envId: string): void {
  rmSync(imagePath(ctx, envId), { force: true });
  rmSync(metaPath(ctx, envId), { force: true });
}

/** Captures the env's live URL in the background; never throws, never waits. */
export function capturePreview(ctx: Ctx, appId: string, envId: string, deployment: number): void {
  if (inFlight.has(envId)) return;
  const executablePath = process.env.CHROMIUM_PATH;
  if (!executablePath) {
    if (!warnedMissing) console.log('[preview] CHROMIUM_PATH is not set; app screenshots are off');
    warnedMissing = true;
    return;
  }
  inFlight.add(envId);
  void (async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        capture(ctx, appId, envId, deployment, executablePath),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
        }),
      ]);
      failures.delete(envId);
    } catch (err) {
      const reason = reasonOf(err as Error);
      failures.set(envId, { at: now(), reason });
      recordLogs(ctx, envId, [{ ts: now(), source: 'system', level: 'warn', line: `console screenshot of #${deployment} not taken: ${reason}`, deployment }]);
    } finally {
      clearTimeout(timer);
      inFlight.delete(envId);
    }
  })();
}

/** On view: re-capture a live, awake env whose picture is missing or older than 24 h (never wakes a sleeping Box). */
export function refreshPreviewIfStale(ctx: Ctx, app: AppRow, env: EnvRow, boxState: string | null): void {
  if (!env.live_deployment || !env.box_id || boxState !== 'running') return;
  const meta = previewMeta(ctx, env.id);
  if (meta && Date.now() - Date.parse(meta.capturedAt) < STALE_MS) return;
  capturePreview(ctx, app.id, env.id, env.live_deployment);
}

async function capture(ctx: Ctx, appId: string, envId: string, deployment: number, executablePath: string): Promise<void> {
  const app = ctx.store.appById(appId);
  const env = ctx.store.envById(envId);
  if (!app || !env) return;
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    // Public envs open directly; others through a one-time ticket that sets the access cookie.
    const url = ctx.resources.effectiveAccess(env) === 'public' ? ctx.resources.appUrl(app.name, env.name) + '/' : createOpenTicket(ctx, app, env, '/', 'system').url;
    // Whatever the app shows is the picture, its error pages included: that is what visitors see.
    // The CP's own "Starting…" page is not the app, so wait for the app instead, and keep the old
    // picture if it never finishes starting.
    const deadline = Date.now() + STARTING_WAIT_MS;
    let res = await page.goto(url, { waitUntil: 'load', timeout: LOAD_MS });
    while (res?.headers()['x-boxlite-starting'] && Date.now() < deadline) {
      await page.waitForTimeout(3000);
      res = await page.reload({ waitUntil: 'load', timeout: LOAD_MS });
    }
    if (res?.headers()['x-boxlite-starting']) throw new Error('the app was still starting');
    // The platform's own page (not deployed, unavailable, private) is not the app: keep the old picture.
    if (res?.headers()['x-boxlite-page']) throw new Error(`the site showed a ${res.status()} page instead of the app`);
    // Let it fetch its data, but a page that keeps a request open or polls never goes idle.
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => undefined);
    await page.waitForTimeout(500);
    const shot = await page.screenshot({ type: 'jpeg', quality: 72 });
    mkdirSync(dir(ctx), { recursive: true });
    // Write then rename, so a reader never sees half an image.
    writeFileSync(imagePath(ctx, envId) + '.tmp', shot);
    renameSync(imagePath(ctx, envId) + '.tmp', imagePath(ctx, envId));
    writeFileSync(metaPath(ctx, envId), JSON.stringify({ capturedAt: now(), deployment } satisfies PreviewMeta));
  } finally {
    await browser.close().catch(() => undefined);
  }
}
