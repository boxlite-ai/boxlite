import { ACTIVE_STATUSES, type AppRow, type Deployment, type EnvRow } from './db'
import type { Ctx } from './ctx'
import { deploymentLogs, formatLogLine } from './services/logs'
import { buildWarnings, type BuildWarning } from '@boxlite-ai/cloud-app-shared'

/** Deployment object of contracts §1. `detail` adds the log tail. */
export async function deploymentView(
  ctx: Pick<Ctx, 'store' | 'resources'>,
  app: AppRow,
  env: EnvRow,
  d: Deployment,
  detail = false,
): Promise<Record<string, unknown>> {
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
    url: await ctx.resources.appUrl(app.name, env.name),
  }
  if (detail) {
    out.log_tail = await logTail(ctx, env, d, 50)
    out.build_warnings = await deploymentBuildWarnings(ctx, env, d.number)
  }
  return out
}

/** What the build of deployment `n` warned about (npm audit, bundle size, deprecated packages). */
export async function deploymentBuildWarnings(
  ctx: Pick<Ctx, 'store'>,
  env: EnvRow,
  n: number,
): Promise<BuildWarning[]> {
  return buildWarnings(
    (await ctx.store.logs(env.id, { source: 'build', deployment: n, limit: 5000 })).map((l) => l.line),
  )
}

/** The last `n` lines of a deployment (its own and its release's), formatted. */
export async function logTail(ctx: Pick<Ctx, 'store'>, env: EnvRow, d: Deployment, n: number): Promise<string[]> {
  return (await deploymentLogs(ctx.store, env.id, d, n)).map(formatLogLine)
}

export async function envStatus(ctx: Pick<Ctx, 'store'>, env: EnvRow): Promise<string> {
  const latest = (await ctx.store.deployments(env.id, 1))[0]
  if (!latest) return 'new'
  if (ACTIVE_STATUSES.includes(latest.status)) return 'deploying'
  if (env.live_deployment) return latest.status === 'failed' ? 'live (last deployment failed)' : 'live'
  return latest.status === 'failed' ? 'failed' : 'new'
}

export interface EnvSummaryView {
  name: string
  status: string
  url: string
  access: string
  spec_version: number | null
  latest_deployment: { number: number; kind: string; status: string; message: string | null; created_at: string } | null
  live_deployment: { number: number; kind: string; release: number | null; live_at: string | null } | null
  box: { id: string; image: string | null; size: string | null } | null
  database: { branch: string } | null
  from: string | null
  created_at: string
}

export async function envSummary(
  ctx: Pick<Ctx, 'store' | 'resources'>,
  app: AppRow,
  env: EnvRow,
): Promise<EnvSummaryView> {
  const latest = (await ctx.store.deployments(env.id, 1))[0]
  const live = env.live_deployment ? await ctx.store.deployment(env.id, env.live_deployment) : undefined
  return {
    name: env.name,
    status: await envStatus(ctx, env),
    url: await ctx.resources.appUrl(app.name, env.name),
    access: await ctx.resources.effectiveAccess(env),
    // The version an agent must plan against: failed deployments do not count (see effectiveSpecVersion).
    spec_version: await ctx.store.effectiveSpecVersion(env.id),
    latest_deployment: latest
      ? {
          number: latest.number,
          kind: latest.kind,
          status: latest.status,
          message: latest.message,
          created_at: latest.created_at,
        }
      : null,
    live_deployment: live
      ? { number: live.number, kind: live.kind, release: live.release, live_at: live.live_at }
      : null,
    box: env.box_id ? { id: env.box_id, image: env.box_image, size: env.box_size } : null,
    database: env.neon_branch_id ? { branch: env.neon_branch_id } : null,
    from: env.from_env,
    created_at: env.created_at,
  }
}
