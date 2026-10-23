import { ACTIVE_STATUSES, type AppRow, type Deployment, type EnvRow } from './db.js';
import type { Ctx } from './ctx.js';
import { deploymentLogs, formatLogLine } from './services/logs.js';
import { buildWarnings, type BuildWarning } from '@microcloud/shared';

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
    out.build_warnings = deploymentBuildWarnings(ctx, env, d.number);
  }
  return out;
}

/** What the build of deployment `n` warned about (npm audit, bundle size, deprecated packages). */
export function deploymentBuildWarnings(ctx: Pick<Ctx, 'store'>, env: EnvRow, n: number): BuildWarning[] {
  return buildWarnings(ctx.store.logs(env.id, { source: 'build', deployment: n, limit: 5000 }).map((l) => l.line));
}

/** The last `n` lines of a deployment (its own and its release's), formatted. */
export function logTail(ctx: Pick<Ctx, 'store'>, env: EnvRow, d: Deployment, n: number): string[] {
  return deploymentLogs(ctx.store, env.id, d, n).map(formatLogLine);
}

export function envStatus(ctx: Pick<Ctx, 'store'>, env: EnvRow): string {
  const latest = ctx.store.deployments(env.id, 1)[0];
  if (!latest) return 'new';
  if (ACTIVE_STATUSES.includes(latest.status)) return 'deploying';
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
    // The version an agent must plan against: failed deployments do not count (see effectiveSpecVersion).
    spec_version: ctx.store.effectiveSpecVersion(env.id),
    latest_deployment: latest ? { number: latest.number, kind: latest.kind, status: latest.status, message: latest.message, created_at: latest.created_at } : null,
    live_deployment: live ? { number: live.number, kind: live.kind, release: live.release, live_at: live.live_at } : null,
    box: env.box_id ? { id: env.box_id, image: env.box_image, size: env.box_size } : null,
    database: env.neon_branch_id ? { branch: env.neon_branch_id } : null,
    from: env.from_env,
    created_at: env.created_at,
  };
}
