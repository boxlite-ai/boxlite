import type { Ctx } from './ctx.js';
import type { LogLine } from './db.js';
import { logsTopic } from './events.js';

/** Stores log lines in the env's ring and fans them out to `logs --follow` subscribers. */
export function recordLogs(ctx: Pick<Ctx, 'store' | 'bus'>, envId: string, lines: LogLine[]): LogLine[] {
  const stored = ctx.store.appendLogs(envId, lines);
  for (const l of stored) ctx.bus.publish(logsTopic(envId), l);
  return stored;
}
