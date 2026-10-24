/** Reports from agents about the platform itself (boxlite-app feedback "<message>"): stored redacted, read by the platform admin. */
import { redact } from '@microcloud/shared';
import { newId } from './auth.js';
import type { Ctx } from './ctx.js';
import { now } from './db.js';
import { fail } from './errors.js';

/** Reports one App may file per hour; more is a loop, not news. */
export const FEEDBACK_PER_HOUR = 20;

export interface FeedbackInput {
  message: string;
  command?: string;
  env?: string;
  cli_version?: string;
}

export interface FeedbackRow {
  id: string;
  app: string;
  env: string | null;
  actor: string;
  message: string;
  command: string | null;
  cli_version: string | null;
  created_at: string;
}

export function recordFeedback(ctx: Pick<Ctx, 'store'>, appId: string, actor: string, input: FeedbackInput): { id: string; received_at: string } {
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const recent = ctx.store.get<{ n: number }>('SELECT count(*) AS n FROM feedback WHERE app_id = ? AND created_at >= ?', appId, since)!.n;
  if (recent >= FEEDBACK_PER_HOUR) throw fail('rate_limited', `${FEEDBACK_PER_HOUR} reports in the last hour already`, 'add to an earlier report later, and carry on with a workaround');
  const id = newId('fb');
  const at = now();
  ctx.store.run(
    'INSERT INTO feedback (id, app_id, env, actor, message, command, cli_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    appId,
    input.env ?? null,
    actor,
    redact(input.message),
    input.command ? redact(input.command) : null,
    input.cli_version ?? null,
    at,
  );
  return { id, received_at: at };
}

export function listFeedback(ctx: Pick<Ctx, 'store'>, limit = 200): FeedbackRow[] {
  return ctx.store.all<FeedbackRow>(
    'SELECT f.id, a.name AS app, f.env, f.actor, f.message, f.command, f.cli_version, f.created_at FROM feedback f JOIN apps a ON a.id = f.app_id ORDER BY f.created_at DESC LIMIT ?',
    limit,
  );
}
