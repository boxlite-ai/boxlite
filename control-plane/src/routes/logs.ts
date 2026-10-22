import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Vars } from '../auth.js';
import type { LogLine } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';
import { logsTopic } from '../events.js';
import { credentialOf, limitsOf, sseBusy, sseSlot } from '../limits.js';
import { parseSince } from '../services/logs.js';
import { envOf } from './util.js';

const view = (l: LogLine) => ({ id: l.id, ts: l.ts, source: l.source, level: l.level, line: l.line, deployment: l.deployment ?? null });

export function logRoutes(ctx: Ctx) {
  const r = new Hono<{ Variables: Vars }>();

  r.get('/envs/:env/logs', async (c) => {
    const env = envOf(ctx, c);
    const source = c.req.query('source') || undefined;
    const since = parseSince(c.req.query('since'));
    const limit = Number(c.req.query('limit') ?? 200) || 200;

    // ?box=1 reads the supervisor's local ring buffer, for when pushes to the CP were missed.
    if (c.req.query('box') === '1') {
      if (!env.box_url) throw fail('not_found', 'this environment has no Box yet');
      return c.json(await ctx.supervisor.logs(env.box_url, env.control_secret, source ?? null, Math.min(limit, 2000)));
    }

    const history = ctx.store.logs(env.id, { source, since, limit });
    if (c.req.query('follow') !== '1') return c.json(history.map(view));

    const release = sseSlot(ctx, env.id, credentialOf(c));
    if (!release) return sseBusy(c, ctx);
    const heartbeatMs = limitsOf(ctx).limits.sseHeartbeatMs;
    return streamSSE(c, async (stream) => {
      const queue: LogLine[] = [];
      let wake: (() => void) | null = null;
      let aborted = false;
      const unsubscribe = ctx.bus.subscribe(logsTopic(env.id), (l) => {
        const line = l as LogLine;
        if (source && line.source !== source) return;
        queue.push(line);
        wake?.();
      });
      stream.onAbort(() => {
        aborted = true;
        wake?.();
      });
      let last = 0;
      const send = async (l: LogLine) => {
        if ((l.id ?? 0) <= last) return;
        last = l.id ?? last;
        await stream.writeSSE({ id: String(l.id), event: 'log', data: JSON.stringify(view(l)) });
      };
      try {
        for (const l of history) await send(l);
        while (!aborted) {
          while (queue.length) await send(queue.shift()!);
          const timedOut = await new Promise<boolean>((res) => {
            const t = setTimeout(() => res(true), heartbeatMs);
            wake = () => {
              clearTimeout(t);
              res(false);
            };
          });
          wake = null;
          if (timedOut && !aborted) await stream.write(': keepalive\n\n');
        }
      } finally {
        unsubscribe();
        release();
      }
    });
  });

  return r;
}
