/**
 * Acknowledging an info finding of `app context` on purpose (`boxlite-app app ack <id> "<reason>"`):
 * a public site the user asked for, a variable that only looks like a credential. Only `info`
 * findings qualify (warnings and errors need a fix), and an acknowledgement covers that exact
 * finding: when its title changes (another variable, another provider), it comes back.
 */
import type { AcknowledgedFinding, AgentContext, Finding } from '@microcloud/shared';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { fail } from '../errors.js';

interface AckRow {
  finding_id: string;
  title: string;
  reason: string;
  by: string;
  created_at: string;
}

/** Splits the findings into what still needs attention and what was acknowledged as it stands. */
export function applyAcks(ctx: Pick<Ctx, 'store'>, env: EnvRow, findings: Finding[]): { next_actions: Finding[]; acknowledged: AcknowledgedFinding[] } {
  const acks = new Map(ctx.store.all<AckRow>('SELECT finding_id, title, reason, by, created_at FROM finding_acks WHERE env_id = ?', env.id).map((a) => [a.finding_id, a]));
  const next_actions: Finding[] = [];
  const acknowledged: AcknowledgedFinding[] = [];
  for (const f of findings) {
    const a = acks.get(f.id);
    if (a && a.title === f.title && f.severity === 'info') acknowledged.push({ id: f.id, title: f.title, reason: a.reason, by: a.by, at: a.created_at });
    else next_actions.push(f);
  }
  return { next_actions, acknowledged };
}

export function ackFinding(ctx: Ctx, app: AppRow, env: EnvRow, current: AgentContext, id: string, reason: string, actor: string): AcknowledgedFinding {
  const why = reason.trim();
  if (!why) throw fail('invalid_request', 'say why it is fine as it is', '`boxlite-app app ack public_anonymous "the user asked for a public site"`');
  const f = current.next_actions.find((x) => x.id === id);
  if (!f) {
    const ids = current.next_actions.map((x) => x.id).join(', ') || 'none';
    throw fail('not_found', `no finding "${id}" in ${env.name} now`, `\`boxlite-app app context\` lists them (now: ${ids})`);
  }
  if (f.severity !== 'info') throw fail('invalid_request', `"${id}" is a${f.severity === 'error' ? 'n error' : ' warning'}; only info findings can be acknowledged`, f.fix);
  const at = now();
  ctx.store.run(
    `INSERT INTO finding_acks (env_id, finding_id, title, reason, by, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (env_id, finding_id) DO UPDATE SET title = excluded.title, reason = excluded.reason, by = excluded.by, created_at = excluded.created_at`,
    env.id,
    id,
    f.title,
    why.slice(0, 500),
    actor,
    at,
  );
  ctx.store.recordActivity(app.id, env.name, actor, 'finding.ack', { id, reason: why.slice(0, 200) });
  return { id, title: f.title, reason: why.slice(0, 500), by: actor, at };
}

export function unackFinding(ctx: Ctx, app: AppRow, env: EnvRow, id: string, actor: string): { unacknowledged: string } {
  if (!Number(ctx.store.run('DELETE FROM finding_acks WHERE env_id = ? AND finding_id = ?', env.id, id).changes)) {
    throw fail('not_found', `"${id}" is not acknowledged in ${env.name}`, '`boxlite-app app context` lists the acknowledged findings');
  }
  ctx.store.recordActivity(app.id, env.name, actor, 'finding.unack', { id });
  return { unacknowledged: id };
}
