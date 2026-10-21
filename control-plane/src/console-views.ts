import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AppRow, Deployment, EnvRow } from './db.js';
import { ACTIVE_STATUSES } from './db.js';
import type { Ctx } from './ctx.js';
import { schedulesOf } from './agent-context.js';
import type { AccessLog } from './console-access.js';
import { activityView, actorLabel, type ActivityView } from './console-activity.js';
import { changeText, failureView, runningStepStartedAt } from './console-deployment.js';
import { endUserAuth, type AuthStatusView } from './console-enduser.js';
import { requestJson } from './http.js';
import { BOX_SIZES } from './platform.js';
import type { Spec } from './spec.js';
import type { ServiceState } from './supervisor.js';

/**
 * Builds the console's view objects (the shapes of the dashboard's lib/apps/types.ts) from real CP
 * state. Where the CP has no data a field is null or empty and the console hides it; nothing here
 * invents a number.
 */

export type ConsoleStatus = 'draft' | 'building' | 'live' | 'degraded' | 'sleeping' | 'failed';
type Access = 'private' | 'org' | 'public';

export interface LastDeployView {
  releaseId: string;
  at: string;
  by: string;
}

export interface AppSummaryView {
  id: string;
  name: string;
  slug: string;
  /** The env's own origin, as the CP serves it (resources.appUrl); exists from creation. */
  url: string;
  visibility: Access;
  status: ConsoleStatus;
  lastDeploy: LastDeployView | null;
  resources: { database: boolean; storage: number; users: null };
  createdAt: string;
  environments: number;
  attention?: string;
  /** While main deploys: "Deploying #4 · build". */
  progress?: string;
}

export interface EnvironmentSummaryView {
  name: string;
  status: ConsoleStatus;
  url: string;
  box: string | null;
  lastDeploy: LastDeployView | null;
  from: string | null;
}

export interface ServiceView {
  name: string;
  command: string[];
  exposed: boolean;
  port?: number;
  healthPath?: string;
  staticDir?: string;
  state: string;
  pid?: number;
  restarts: number;
  lastExitCode?: number;
  health: string;
  /** The service's last error lines, when it is crashing, restarting or unhealthy. */
  recentErrors: string[];
}

export interface ScheduleView {
  name: string;
  cron: string;
  target: string;
  /** null while nothing is live (schedules only run against a live release). */
  nextRun: string | null;
  lastRun: string | null;
  /** HTTP status of the last run. */
  lastStatus: number | null;
}

export interface ReleaseView {
  id: string;
  number: number;
  summary: string;
  createdAt: string;
  finishedAt: string | null;
  by: string;
  status: Deployment['status'];
  current: boolean;
  error?: string;
  steps: Deployment['steps'];
  changes: string[];
  files: number | null;
  bytes: number | null;
  buildSeconds: number | null;
  hasSource: boolean;
  rollback: { possible: boolean; reason?: string };
  restorePoint: string | null;
  startedAt: string | null;
  /** The step running now and since when, while the deployment is in progress. */
  running: { name: string; detail?: string; since: string | null } | null;
  /** For a failed deployment: the classified cause, in a line. */
  cause: string | null;
}

export interface DatabaseSummaryView {
  status: 'ready';
  engine: string;
  host: string;
  name: string;
  user: string;
  branch: string | null;
  injectedAs: string;
  injectedInto: string[];
}

export interface VolumeView {
  name: string;
  mountPath: string;
  mode: string;
  volumeName: string;
  volumeId: string | null;
  sizeBytes: number | null;
  state: string | null;
}

export interface SecretRefView {
  name: string;
  from: string;
  inject: 'env';
  usedBy: string[];
  /** false when the org secret it names has been deleted since. */
  present: boolean;
}

export interface ProblemView {
  summary: string;
  detail: string;
  fixPrompt?: string;
  /** The failed deployment this problem is about. */
  deployment?: number;
  /** What still serves users, when something does. */
  serving?: string;
}

export interface AppDetailView extends Omit<AppSummaryView, 'environments'> {
  environment: string;
  createdFrom: string | null;
  runtime: { image: string; size: string; cpus: number | null; memoryMib: number | null } | null;
  box: { id: string; state: string } | null;
  services: ServiceView[];
  activeRelease: string | null;
  releases: ReleaseView[];
  activity: ActivityView[];
  database: DatabaseSummaryView | null;
  storages: VolumeView[];
  secrets: SecretRefView[];
  /** [variables] of the latest spec; null before the first apply/deploy (nothing to edit yet). */
  variables: Record<string, string> | null;
  platformVariables: { name: string; value: string; kind: string }[];
  problems: ProblemView[];
  statusDetail: string | null;
  /** The deployment in progress, for the header's live line. */
  deploying: { id: string; number: number; step: string | null; detail: string | null; since: string } | null;
  schedules: ScheduleView[];
  /** [variables] of the live release; differs from `variables` while a change is being deployed. */
  liveVariables: Record<string, string> | null;
  metrics: { requests: number[]; errors: number[]; p95Ms: number[]; previousRequests: number } | null;
  handoffPrompt: string;
  key: { last4: string; createdAt: string } | null;
  accessSource: 'manifest' | 'online';
  specVersion: number | null;
  auth: AuthStatusView;
}

// ---- small helpers -----------------------------------------------------------

export const releaseId = (n: number) => `#${n}`;

function lastDeploy(d: Deployment | undefined): LastDeployView | null {
  return d ? { releaseId: releaseId(d.number), at: d.created_at, by: actorLabel(d.by) } : null;
}

function parseServices(env: EnvRow): ServiceState[] {
  try {
    return env.services ? (JSON.parse(env.services) as ServiceState[]) : [];
  } catch {
    return [];
  }
}

/** Runtime state of an env in the console's words. `box` is the BoxLite status, `services` the supervisor's report. */
export function envStatus(ctx: Pick<Ctx, 'store'>, env: EnvRow, box: string | null, services: ServiceState[]): ConsoleStatus {
  const latest = ctx.store.deployments(env.id, 1)[0];
  if (!latest) return 'draft';
  if (ACTIVE_STATUSES.includes(latest.status)) return 'building';
  // An apply before any deploy is "live" in the CP but nothing runs yet.
  if (!env.live_deployment || !env.box_id) return latest.status === 'failed' ? 'failed' : 'draft';
  if (box === 'stopped') return 'sleeping';
  if (services.some((s) => s.state === 'failed' || s.health === 'unhealthy')) return 'degraded';
  return 'live';
}

function failureLine(d: Deployment): string | undefined {
  if (d.status !== 'failed' || !d.error) return undefined;
  return `#${d.number} failed at ${d.error.step}: ${d.error.message}`;
}

/** The agent's message when it gave one; otherwise what changed, from the CP's own diff. */
function summaryOf(d: Deployment): string {
  if (d.message) return d.message;
  const paths = d.changes.map((c) => `${c.kind === 'online_only' ? '' : c.kind}${c.path}`);
  if (paths.length) return paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` (+${paths.length - 3} more)` : '');
  return d.kind === 'deploy' ? 'Deploy' : d.kind === 'apply' ? 'Configuration change' : 'Rollback';
}

// ---- prompt -----------------------------------------------------------------

const FALLBACK_TEMPLATE = `You are building an app on BoxLite Cloud. First read {{CP_URL}}/agent.md and follow it exactly.

BOXLITE_API_URL={{CP_URL}}
BOXLITE_API_KEY={{APP_KEY}}
App: {{APP}}

What I want: {{REQUEST}}
`;

function promptTemplate(ctx: Pick<Ctx, 'config'>): string {
  const path = process.env.PROMPT_TEMPLATE_PATH ? resolve(process.env.PROMPT_TEMPLATE_PATH) : join(dirname(ctx.config.agentMdPath), 'prompt-template.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : FALLBACK_TEMPLATE;
}

/** agent/prompt-template.md filled in. Without a request the "What I want" line is left for the user to finish in their agent. */
export function handoffPrompt(ctx: Pick<Ctx, 'config'>, app: string, key: string, request?: string): string {
  let text = promptTemplate(ctx).replaceAll('{{CP_URL}}', ctx.config.publicUrl).replaceAll('{{APP_KEY}}', key).replaceAll('{{APP}}', app);
  if (request?.trim()) text = text.replaceAll('{{REQUEST}}', request.trim());
  else text = text.replace(/^.*\{\{REQUEST\}\}.*$/m, 'What I want: (tell your agent here)');
  return text.trimEnd() + '\n';
}

export const maskKey = (last4: string) => `bxl_app_••••••••••••${last4}`;

export function currentKey(ctx: Pick<Ctx, 'store'>, app: AppRow): { last4: string; createdAt: string } | null {
  const row = ctx.store.get<{ last4: string; created_at: string }>('SELECT last4, created_at FROM keys WHERE app_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', app.id);
  return row ? { last4: row.last4, createdAt: row.created_at } : null;
}

// ---- BoxLite volumes (size/state when the API reports them) ------------------

let volumeCache: { at: number; list: Record<string, unknown>[] } | null = null;

async function boxliteVolumes(ctx: Pick<Ctx, 'config'>): Promise<Record<string, unknown>[] | null> {
  if (volumeCache && Date.now() - volumeCache.at < 15_000) return volumeCache.list;
  if (!ctx.config.boxliteApiKey) return null;
  try {
    const { body } = await requestJson<{ volumes?: Record<string, unknown>[] } | Record<string, unknown>[]>('boxlite', {
      method: 'GET',
      url: `${ctx.config.boxliteApiUrl}/volumes`,
      headers: { authorization: `Bearer ${ctx.config.boxliteApiKey}` },
      timeoutMs: 8_000,
    });
    const list = Array.isArray(body) ? body : (body.volumes ?? []);
    volumeCache = { at: Date.now(), list };
    return list;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

export async function volumeViews(ctx: Pick<Ctx, 'config'>, app: AppRow, env: EnvRow, spec: Spec | undefined): Promise<VolumeView[]> {
  const declared = spec?.volumes ?? [];
  if (!declared.length) return [];
  const remote = await boxliteVolumes(ctx);
  return declared.map((v) => {
    const volumeName = `mc-${app.name}-${env.name}-${v.name}`;
    const r = remote?.find((x) => x.name === volumeName);
    const sizeBytes = r ? (num(r.size_bytes) ?? num(r.used_bytes) ?? (num(r.size_gb) !== null ? num(r.size_gb)! * 1024 ** 3 : null)) : null;
    return {
      name: v.name,
      mountPath: v.mount,
      mode: v.mode,
      volumeName,
      volumeId: r ? String(r.volume_id ?? r.id ?? '') || null : null,
      sizeBytes,
      state: r && typeof (r.state ?? r.status) === 'string' ? String(r.state ?? r.status) : null,
    };
  });
}

// ---- deployments -----------------------------------------------------------------

export function releaseViews(ctx: Pick<Ctx, 'store' | 'orchestrator'>, app: AppRow, env: EnvRow, limit = 50): ReleaseView[] {
  return ctx.store.deployments(env.id, limit).map((d) => {
    const snap = d.snapshot_id ? ctx.store.snapshot(app.id, d.snapshot_id) : undefined;
    const build = d.steps.find((s) => s.name === 'build' && s.status === 'done');
    const current = env.live_deployment === d.number;
    // A rollback restores the target's code and configuration, so an older deployment of the live release still counts.
    const problem = current ? 'this deployment is live' : ctx.orchestrator.rollbackProblem(env, d.number);
    return {
      id: releaseId(d.number),
      number: d.number,
      summary: summaryOf(d),
      createdAt: d.created_at,
      finishedAt: d.finished_at,
      by: actorLabel(d.by),
      status: d.status,
      current,
      ...(d.error ? { error: `${d.error.step}: ${d.error.message}` } : {}),
      steps: d.steps,
      changes: d.changes.map(changeText),
      files: snap?.files ?? null,
      bytes: snap?.bytes ?? null,
      buildSeconds: build?.ms !== undefined ? Math.round(build.ms / 100) / 10 : null,
      hasSource: !!snap,
      rollback: problem ? { possible: false, reason: problem } : { possible: true },
      restorePoint: d.restore_point,
      startedAt: d.started_at,
      running: ACTIVE_STATUSES.includes(d.status) ? runningOf(ctx, env, d) : null,
      cause: failureView(ctx, app, env, d)?.diagnosis.summary ?? null,
    };
  });
}

function runningOf(ctx: Pick<Ctx, 'store'>, env: EnvRow, d: Deployment): ReleaseView['running'] {
  const step = d.steps.find((s) => s.status === 'running');
  if (!step) return null;
  return { name: step.name, ...(step.detail ? { detail: step.detail } : {}), since: runningStepStartedAt(ctx, env, d) };
}

// ---- summary / detail ----------------------------------------------------------------

export interface LiveState {
  box: string | null;
  services: ServiceState[];
}

/** BoxLite status of the env's Box (cached by Resources) and the supervisor's last service report. */
export async function liveState(ctx: Ctx, env: EnvRow, opts: { probe?: boolean } = {}): Promise<LiveState> {
  let box: string | null = null;
  if (env.box_id) box = await ctx.resources.boxStatus(env.box_id).catch(() => 'unknown');
  let services = parseServices(env);
  // Ask the supervisor for fresh health when the Box is up; the stored report is the fallback.
  if (opts.probe && box === 'running' && env.box_url) {
    const h = await Promise.race([
      ctx.supervisor.health(env.box_url, env.control_secret).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
    ]);
    if (h) {
      services = h.services;
      ctx.store.updateEnv(env.id, { services: JSON.stringify(h.services) });
    }
  }
  return { box, services };
}

export async function summaryView(ctx: Ctx, app: AppRow): Promise<AppSummaryView> {
  const envs = ctx.store.envs(app.id);
  const main = envs.find((e) => e.name === 'main') ?? envs[0]!;
  const state = await liveState(ctx, main);
  const latest = ctx.store.deployments(main.id, 1)[0];
  const spec = ctx.store.spec(main.id);
  const status = envStatus(ctx, main, state.box, state.services);
  const attention = latest ? failureLine(latest) : undefined;
  const step = latest && ACTIVE_STATUSES.includes(latest.status) ? (latest.steps.find((s) => s.status === 'running')?.name ?? latest.status) : null;
  return {
    id: app.name,
    name: app.name,
    slug: app.name,
    url: ctx.resources.appUrl(app.name, main.name) + '/',
    visibility: ctx.resources.effectiveAccess(main),
    status,
    lastDeploy: lastDeploy(latest),
    resources: { database: !!main.db_url, storage: spec?.volumes.length ?? 0, users: null },
    createdAt: app.created_at,
    environments: envs.length,
    ...(attention ? { attention } : {}),
    ...(step ? { progress: `Deploying ${releaseId(latest!.number)} · ${step}` } : {}),
  };
}

export async function environmentViews(ctx: Ctx, app: AppRow): Promise<EnvironmentSummaryView[]> {
  return Promise.all(
    ctx.store.envs(app.id).map(async (env) => {
      const state = await liveState(ctx, env);
      return {
        name: env.name,
        status: envStatus(ctx, env, state.box, state.services),
        url: ctx.resources.appUrl(app.name, env.name) + '/',
        box: env.box_id,
        lastDeploy: lastDeploy(ctx.store.deployments(env.id, 1)[0]),
        from: env.from_env,
      };
    }),
  );
}

/** An asleep Box runs nothing, whatever the supervisor last reported. */
const asleep = (sv: ServiceView): ServiceView => ({ ...sv, state: 'asleep', health: 'none', port: undefined, pid: undefined, recentErrors: [] });

/** A service is in trouble when it crashed, keeps restarting, fails its health check or last exited non-zero. */
const troubled = (r: ServiceState | undefined) =>
  !!r && (r.state === 'failed' || r.state === 'restarting' || r.health === 'unhealthy' || (r.last_exit_code ?? 0) !== 0);

function recentErrors(ctx: Pick<Ctx, 'store'>, env: EnvRow, service: string): string[] {
  return ctx.store
    .logs(env.id, { source: service, limit: 200 })
    .filter((l) => l.level === 'error')
    .slice(-8)
    .map((l) => `${l.ts} ${l.line}`);
}

function serviceViews(ctx: Pick<Ctx, 'store'>, env: EnvRow, spec: Spec | undefined, reported: ServiceState[]): ServiceView[] {
  const declared = spec?.services ?? [];
  const exposedName = declared.find((s) => s.port !== undefined || s.static)?.name;
  const names = [...new Set([...declared.map((s) => s.name), ...reported.map((s) => s.name)])];
  return names.map((name) => {
    const d = declared.find((s) => s.name === name);
    const r = reported.find((s) => s.name === name);
    return {
      name,
      command: d?.command ? [d.command] : d?.static ? [`static ${d.static}`] : [],
      exposed: name === exposedName,
      ...(r?.port ? { port: r.port } : {}),
      ...(d?.health ? { healthPath: d.health } : {}),
      ...(d?.static ? { staticDir: d.static } : {}),
      state: r?.state ?? 'stopped',
      ...(r?.pid ? { pid: r.pid } : {}),
      restarts: r?.restarts ?? 0,
      ...(r?.last_exit_code !== undefined && r?.last_exit_code !== null ? { lastExitCode: r.last_exit_code } : {}),
      health: r?.health ?? 'none',
      recentErrors: troubled(r) ? recentErrors(ctx, env, name) : [],
    };
  });
}

function problemsOf(ctx: Pick<Ctx, 'store'>, app: AppRow, env: EnvRow, latest: Deployment | undefined, services: ServiceView[], reportedAny: boolean): ProblemView[] {
  const out: ProblemView[] = [];
  const failure = latest ? failureView(ctx, app, env, latest) : null;
  if (latest && failure) {
    out.push({
      summary: `Deployment #${latest.number} failed at ${failure.step}`,
      detail: `${failure.diagnosis.summary}. Fix: ${failure.diagnosis.fix}`,
      fixPrompt: failure.fixPrompt,
      deployment: latest.number,
      ...(env.live_deployment && env.box_id ? { serving: releaseId(env.live_deployment) } : {}),
    });
  }
  if (reportedAny && env.live_deployment) {
    for (const s of services) {
      if (s.state !== 'failed' && s.health !== 'unhealthy') continue;
      out.push({
        summary: s.state === 'failed' ? `${s.name} has crashed` : `${s.name} is failing its health check`,
        detail: [s.lastExitCode !== undefined ? `last exit code ${s.lastExitCode}` : null, `${s.restarts} restart${s.restarts === 1 ? '' : 's'}`, s.healthPath ? `health path ${s.healthPath}` : null]
          .filter(Boolean)
          .join(' · '),
        fixPrompt: `The service "${s.name}" of the BoxLite app "${app.name}" (environment ${env.name}) is ${s.state === 'failed' ? 'crashing' : 'failing its health check'}.\nRead \`boxlite-app app logs --source ${s.name} --since 30m\` and \`boxlite-app app services\`, fix the cause, then deploy again.`,
      });
    }
  }
  return out;
}

export async function detailView(ctx: Ctx, access: AccessLog, app: AppRow, env: EnvRow): Promise<AppDetailView> {
  const state = await liveState(ctx, env, { probe: true });
  const fresh = ctx.store.envById(env.id) ?? env;
  const latest = ctx.store.deployments(fresh.id, 1)[0];
  const spec = ctx.store.spec(fresh.id);
  const current = ctx.resources.currentSpec(fresh);
  const status = envStatus(ctx, fresh, state.box, state.services);
  const services = serviceViews(ctx, fresh, current ?? spec, state.services).map((sv) => (state.box === 'stopped' ? asleep(sv) : sv));
  const key = currentKey(ctx, app);
  const size = current ? BOX_SIZES[current.runtime.size] : undefined;
  const attention = latest ? failureLine(latest) : undefined;

  let database: DatabaseSummaryView | null = null;
  if (fresh.db_url) {
    const u = new URL(fresh.db_url);
    database = {
      status: 'ready',
      engine: 'Postgres (Neon)',
      host: u.hostname,
      name: u.pathname.slice(1),
      user: decodeURIComponent(u.username),
      branch: fresh.neon_branch_id,
      injectedAs: 'DATABASE_URL',
      injectedInto: spec?.database ? services.filter((s) => !s.staticDir).map((s) => s.name) : [],
    };
  }

  const platformVariables: { name: string; value: string; kind: string }[] = [
    { name: 'BOXLITE_APP_URL', value: ctx.resources.appUrl(app.name, fresh.name), kind: 'App URL' },
    { name: 'BOXLITE_ENV', value: fresh.name, kind: 'Environment' },
    { name: 'BOXLITE_APP', value: app.name, kind: 'App' },
  ];
  if (database && spec?.database) platformVariables.unshift({ name: 'DATABASE_URL', value: `postgresql://${database.user}@${database.host}/${database.name}?sslmode=require (password hidden)`, kind: 'Database' });
  const exposed = services.find((s) => s.exposed && !s.staticDir);
  if (exposed) platformVariables.push({ name: 'PORT', value: exposed.port ? String(exposed.port) : 'set per start', kind: `Exposed service ${exposed.name}` });

  const active = latest && ACTIVE_STATUSES.includes(latest.status) ? latest : undefined;
  const running = active ? runningOf(ctx, fresh, active) : null;
  const statusDetail =
    status === 'sleeping'
      ? 'Asleep · the next request wakes it in a few seconds'
      : active
        ? `Deploying #${active.number}${running ? ` · ${running.name}${running.detail ? ` (${running.detail})` : ''}` : ` · ${active.status}`}`
        : null;

  return {
    id: app.name,
    name: app.name,
    slug: app.name,
    url: ctx.resources.appUrl(app.name, fresh.name) + '/',
    visibility: ctx.resources.effectiveAccess(fresh),
    accessSource: fresh.access_override ? 'online' : 'manifest',
    status,
    statusDetail,
    lastDeploy: lastDeploy(latest),
    resources: { database: !!fresh.db_url, storage: spec?.volumes.length ?? 0, users: null },
    createdAt: app.created_at,
    ...(attention ? { attention } : {}),
    environment: fresh.name,
    createdFrom: fresh.from_env,
    runtime: current ? { image: current.runtime.image, size: current.runtime.size, cpus: size?.cpus ?? null, memoryMib: size?.memory_mib ?? null } : null,
    box: fresh.box_id ? { id: fresh.box_id, state: state.box ?? 'unknown' } : null,
    services,
    activeRelease: fresh.live_deployment && fresh.box_id ? releaseId(fresh.live_deployment) : null,
    releases: releaseViews(ctx, app, fresh),
    activity: activityView(ctx, app, fresh.name),
    database,
    storages: await volumeViews(ctx, app, fresh, spec),
    secrets: Object.entries(spec?.secrets ?? {}).map(([name, from]) => ({
      name,
      from,
      inject: 'env' as const,
      usedBy: services.filter((s) => !s.staticDir).map((s) => s.name),
      present: ctx.store.secret(from) !== undefined,
    })),
    variables: spec ? { ...spec.variables } : null,
    platformVariables,
    problems: problemsOf(ctx, app, fresh, latest, services, state.services.length > 0),
    deploying: active
      ? { id: releaseId(active.number), number: active.number, step: running?.name ?? null, detail: running?.detail ?? null, since: active.started_at ?? active.created_at }
      : null,
    schedules: schedulesOf(ctx, fresh, current).map((s) => ({ name: s.name, cron: s.cron, target: s.target, nextRun: s.next_run, lastRun: s.last_run, lastStatus: s.last_status })),
    liveVariables: current ? { ...current.variables } : null,
    metrics: access.metrics(fresh.id),
    handoffPrompt: handoffPrompt(ctx, app.name, key ? maskKey(key.last4) : '<rotate the key to get a new one>'),
    key,
    specVersion: spec?.version ?? null,
    auth: endUserAuth.authStatus(ctx, app, fresh),
  };
}
