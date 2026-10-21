import { Cron } from 'croner';
import type { AppRow, EnvRow } from './db.js';
import { now } from './db.js';
import type { Ctx } from './ctx.js';
import { fail } from './errors.js';
import { recordLogs } from './logsink.js';
import { forward } from './routes/proxy.js';

export interface ScheduleRun {
  name: string;
  status: number;
  ms: number;
  starting: boolean;
}

/**
 * Runs `[[schedule]]` entries. Each run is a POST to `<target path>` sent through the same code path
 * as visitor traffic (`forward`), so a stopped Box is woken first. While the Box is still starting
 * the run is retried on the next tick; missed runs are not replayed (at most one run per tick).
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: Ctx) {}

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(at = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { store, resources } = this.ctx;
      for (const env of store.all<EnvRow>('SELECT * FROM envs WHERE live_deployment IS NOT NULL')) {
        const app = store.appById(env.app_id);
        const spec = resources.currentSpec(env);
        if (!app || app.deleted_at || !spec?.schedules.length) continue;
        const live = store.deployment(env.id, env.live_deployment!);
        for (const s of spec.schedules) {
          const row = store.get<{ last_run: string }>('SELECT last_run FROM schedule_runs WHERE env_id = ? AND name = ?', env.id, s.name);
          const since = new Date(row?.last_run ?? live?.live_at ?? at.toISOString());
          let next: Date | null;
          try {
            next = new Cron(s.cron, { paused: true, timezone: 'UTC' }).nextRun(since);
          } catch {
            continue;
          }
          if (next && next <= at) {
            await this.run(app, env, s.name).catch((err) => console.error(`[scheduler] ${app.name}/${env.name}/${s.name}: ${(err as Error).message}`));
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  async run(app: AppRow, env: EnvRow, name: string): Promise<ScheduleRun> {
    const { store, resources } = this.ctx;
    const spec = resources.currentSpec(env);
    const sched = spec?.schedules.find((s) => s.name === name);
    if (!sched) throw fail('not_found', `no schedule "${name}" in the live spec`);
    const path = sched.target.slice(sched.target.indexOf(':') + 1) || '/';
    const started = Date.now();
    // X-Forwarded-Host/Proto default to the env's own origin (BOXLITE_APP_URL).
    const res = await forward(this.ctx, app, env, {
      method: 'POST',
      path: path.startsWith('/') ? path : '/' + path,
      headers: new Headers({ 'x-boxlite-schedule': name, 'user-agent': 'boxlite-scheduler' }),
      body: null,
    });
    await res.body?.cancel().catch(() => undefined);
    const ms = Date.now() - started;
    const starting = res.headers.get('x-boxlite-starting') === '1';
    const line = starting ? `${name}: Box is starting, will retry` : `${name}: POST ${path} → ${res.status} in ${ms} ms`;
    recordLogs(this.ctx, env.id, [{ ts: now(), source: 'schedule', level: res.status >= 400 && !starting ? 'error' : 'info', line, deployment: env.live_deployment }]);
    if (!starting) {
      store.run(
        'INSERT INTO schedule_runs (env_id, name, last_run, last_status) VALUES (?, ?, ?, ?) ON CONFLICT(env_id, name) DO UPDATE SET last_run = excluded.last_run, last_status = excluded.last_status',
        env.id,
        name,
        now(),
        res.status,
      );
    }
    return { name, status: res.status, ms, starting };
  }
}
