import type { Ctx } from './ctx'
import type { LogLine } from './db'
import { logsTopic } from './events'

/** Stores log lines in the env's ring and fans them out to `logs --follow` subscribers. */
export async function recordLogs(ctx: Pick<Ctx, 'store' | 'bus'>, envId: string, lines: LogLine[]): Promise<LogLine[]> {
  const stored = await ctx.store.appendLogs(envId, lines)
  for (const l of stored) ctx.bus.publish(logsTopic(envId), l)
  return stored
}
