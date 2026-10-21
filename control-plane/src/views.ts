import type { AppRow, Deployment, EnvRow } from './db.js';
import type { Ctx } from './ctx.js';

/** Deployment object of contracts §1. `detail` adds the log tail. */
export function deploymentView(ctx: Pick<Ctx, 'store' | 'resources'>, app: AppRow, env: EnvRow, d: Deployment, detail = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    number: d.number,
    kind: d.kind,
    status: d.status,
    message: d.message,
    by: d.by,
    created_at: d.created_at,
    started_at: d.started_at,
    finished_at: d.finished_at,
    spec_version: d.spec_version,
    base_version: d.base_version,
    snapshot_id: d.snapshot_id,
    release: d.release,
    rollback_to: d.kind === 'rollback' ? (d.request.to ?? null) : null,
    restore_point: d.restore_point,
    steps: d.steps,
    changes: d.changes,
    error: d.error,
    url: ctx.resources.appUrl(app.name, env.name),
  };
  if (detail) {
    out.log_tail = logTail(ctx, env, d, 50);
  }
  return out;
}

/**
 * CP lines are tagged with the deployment number, supervisor lines with the release it was told to
 * run; for apply/rollback those differ, so merge both.
 */
export function logTail(ctx: Pick<Ctx, 'store'>, env: EnvRow, d: Deployment, n: number): string[] {
  const own = ctx.store.logs(env.id, { deployment: d.number, limit: n });
  const rel = d.release && d.release !== d.number ? ctx.store.logs(env.id, { deployment: d.release, since: d.started_at ?? d.created_at, limit: n }) : [];
  return [...own, ...rel]
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    .slice(-n)
    .map((l) => `${l.ts} [${l.source}] ${l.line}`);
}

export function envStatus(ctx: Pick<Ctx, 'store'>, env: EnvRow): string {
  const latest = ctx.store.deployments(env.id, 1)[0];
  if (!latest) return 'new';
  if (['queued', 'uploading', 'building', 'migrating', 'starting'].includes(latest.status)) return 'deploying';
  if (env.live_deployment) return latest.status === 'failed' ? 'live (last deployment failed)' : 'live';
  return latest.status === 'failed' ? 'failed' : 'new';
}

export interface EnvSummaryView {
  name: string;
  status: string;
  url: string;
  access: string;
  spec_version: number | null;
  latest_deployment: { number: number; kind: string; status: string; message: string | null; created_at: string } | null;
  live_deployment: { number: number; kind: string; release: number | null; live_at: string | null } | null;
  box: { id: string; image: string | null; size: string | null } | null;
  database: { branch: string } | null;
  from: string | null;
  created_at: string;
}

export function envSummary(ctx: Pick<Ctx, 'store' | 'resources'>, app: AppRow, env: EnvRow): EnvSummaryView {
  const latest = ctx.store.deployments(env.id, 1)[0];
  const live = env.live_deployment ? ctx.store.deployment(env.id, env.live_deployment) : undefined;
  return {
    name: env.name,
    status: envStatus(ctx, env),
    url: ctx.resources.appUrl(app.name, env.name),
    access: ctx.resources.effectiveAccess(env),
    spec_version: ctx.store.latestSpecVersion(env.id),
    latest_deployment: latest ? { number: latest.number, kind: latest.kind, status: latest.status, message: latest.message, created_at: latest.created_at } : null,
    live_deployment: live ? { number: live.number, kind: live.kind, release: live.release, live_at: live.live_at } : null,
    box: env.box_id ? { id: env.box_id, image: env.box_image, size: env.box_size } : null,
    database: env.neon_branch_id ? { branch: env.neon_branch_id } : null,
    from: env.from_env,
    created_at: env.created_at,
  };
}
