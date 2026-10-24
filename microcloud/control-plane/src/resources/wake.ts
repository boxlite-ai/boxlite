/** Box status as the app proxy sees it (cached 5 s), putting a Box to sleep, and waking a stopped Box once. */
import { UpstreamError } from '../errors.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { recordLogs } from '../logsink.js';

/** A wake is not repeated within this window (concurrent requests share it). */
const WAKE_RETRY_MS = 30_000;

export class BoxWaker {
  private readonly boxStatusCache = new Map<string, { status: string; at: number }>();
  private readonly wakes = new Map<string, { at: number; done: Promise<void> }>();
  /** The last failed wake per Box, kept for the 30 s a wake is not retried. */
  private readonly wakeFailures = new Map<string, { at: number; message: string }>();

  constructor(private readonly ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>) {}

  async boxStatus(boxId: string): Promise<string> {
    const hit = this.boxStatusCache.get(boxId);
    if (hit && Date.now() - hit.at < 5_000) return hit.status;
    const box = await this.ctx.boxlite.getBox(boxId);
    const status = box?.status ?? 'missing';
    this.boxStatusCache.set(boxId, { status, at: Date.now() });
    return status;
  }

  /**
   * Stops a Box and remembers it as stopped. Observation (health probes, the console's polling)
   * only talks to running Boxes, and a request to a stopped Box wakes it, so without this the
   * very next page refresh would wake the Box it just put to sleep.
   */
  async sleep(boxId: string): Promise<void> {
    try {
      await this.ctx.boxlite.stopBox(boxId);
    } catch (err) {
      // Already stopped (BoxLite auto-stops idle Boxes): asleep is what was asked for.
      if (!(err instanceof UpstreamError && err.status === 400 && /not started/i.test(err.message))) throw err;
    }
    this.boxStatusCache.set(boxId, { status: 'stopped', at: Date.now() });
  }

  /** A Box this CP just started itself: forget its cached status and count it as recently woken. */
  noteWake(boxId: string): void {
    this.boxStatusCache.delete(boxId);
    this.wakes.set(boxId, { at: Date.now(), done: Promise.resolve() });
  }

  /** True while a Box we woke is probably still booting its supervisor. */
  recentlyWoken(boxId: string): boolean {
    const w = this.wakes.get(boxId);
    return !!w && Date.now() - w.at < 180_000;
  }

  /**
   * Starts a stopped Box once, however many requests ask at the same time. A failure (quota,
   * a refused key) is written to the env's `system` log and kept for 30 s, so visitors get an
   * error page instead of "Starting…" forever; after that the next request tries again.
   */
  async wake(boxId: string): Promise<void> {
    const w = this.wakes.get(boxId);
    if (w && Date.now() - w.at < WAKE_RETRY_MS) return w.done;
    this.wakeFailures.delete(boxId);
    const done = this.ctx.boxlite
      .startBox(boxId)
      .catch((err) => this.wakeFailed(boxId, err as Error))
      .then(() => {
        this.boxStatusCache.delete(boxId);
      });
    this.wakes.set(boxId, { at: Date.now(), done });
    return done;
  }

  /** Why the last wake of this Box failed, while it is not retried yet; null otherwise. */
  wakeFailure(boxId: string): string | null {
    const f = this.wakeFailures.get(boxId);
    return f && Date.now() - f.at < WAKE_RETRY_MS ? f.message : null;
  }

  private wakeFailed(boxId: string, err: Error): void {
    console.error(`[wake] start ${boxId} failed: ${err.message}`);
    this.wakeFailures.set(boxId, { at: Date.now(), message: err.message });
    const env = this.ctx.store.get<{ id: string }>('SELECT id FROM envs WHERE box_id = ?', boxId);
    if (env) {
      recordLogs(this.ctx, env.id, [{ ts: now(), source: 'system', level: 'error', line: `could not start Box ${boxId} for a request: ${err.message}; the next request after 30 s tries again`, deployment: null }]);
    }
  }
}
