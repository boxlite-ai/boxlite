/** Builds the console's app summary and detail views from real CP state. */
import { secretValue } from './orgs.js';
import { errorFocus, missingVariableIn } from '@microcloud/shared';
import type { AppRow, Deployment, EnvRow } from './db.js';
import { ACTIVE_STATUSES, now } from './db.js';
import type { Ctx } from './ctx.js';
import { schedulesOf } from './agent-context.js';
import type { AccessLog } from './console-access.js';
import { activityView } from './console-activity.js';
import { failureView } from './console-deployment.js';
import { endUserAuth } from './console-enduser.js';
import { currentKey, handoffPrompt, maskKey } from './console-prompt.js';
import { lastDeploy, releaseId, releaseViews, runningOf } from './console-releases.js';
import type { AppDetailView, AppSummaryView, ConsoleStatus, DatabaseSummaryView, EnvironmentSummaryView, ProblemView, ServiceView, VolumeView } from './console-view-types.js';
import type { VolumeInfo } from './boxlite.js';
import { BOX_SIZES } from './platform.js';
import { storedServices } from './resources.js';
import { volumeName } from './resources/volumes.js';
import { dbCoordinates } from './services/db.js';
import type { Spec } from './spec.js';
import type { ServiceState } from './supervisor.js';
import { logLevel } from './services/logs.js';
import { previewAttempt, previewMeta, refreshPreviewIfStale } from './preview.js';

/**
 * Builds the console's view objects (the shapes of the dashboard's lib/apps/types.ts) from real CP
 * state. Where the CP has no data a field is null or empty and the console hides it; nothing here
 * invents a number.
 *
 * Split by concern: view types in console-view-types.ts, releases in console-releases.ts, the
 * hand-off prompt in console-prompt.ts; this file builds the app summary and detail views.
 */

// ---- small helpers -----------------------------------------------------------

/** Runtime state of an env in the console's words. `box` is the BoxLite status, `services` the supervisor's report. */
export function envStatus(ctx: Pick<Ctx, 'store'>, env: EnvRow, box: string | null, services: ServiceState[]): ConsoleStatus {
  const latest = ctx.store.deployments(env.id, 1)[0];
  if (!latest) return 'draft';
  if (ACTIVE_STATUSES.includes(latest.status)) return 'building';
  // An apply before any deploy is "live" in the CP but nothing runs yet.
  if (!env.live_deployment || !env.box_id) return latest.status === 'failed' ? 'failed' : 'draft';
  if (box === 'stopped') return 'sleeping';
  if (services.some((s) => s.state === 'failed' || s.health === 'unhealthy' || crashLooping(s))) return 'degraded';
  return 'live';
}

/** The supervisor keeps restarting a service that keeps exiting non-zero: it never serves, though never "failed". */
const crashLooping = (s: { state: string; restarts?: number; last_exit_code?: number | null; lastExitCode?: number }) =>
  s.state === 'restarting' && (s.restarts ?? 0) >= 3 && (s.last_exit_code ?? s.lastExitCode ?? 0) !== 0;

function failureLine(d: Deployment): string | undefined {
  if (d.status !== 'failed' || !d.error) return undefined;
  return `#${d.number} failed at ${d.error.step}: ${d.error.message}`;
}

// ---- BoxLite volumes (size/state when the API reports them) ------------------

/** The org's volume list, per CP (tests get their own), for 15 s: every console poll would list them. */
const volumeCache = new WeakMap<object, { at: number; list: VolumeInfo[] }>();

async function boxliteVolumes(ctx: Pick<Ctx, 'boxlite'>): Promise<VolumeInfo[] | null> {
  const hit = volumeCache.get(ctx.boxlite);
  if (hit && Date.now() - hit.at < 15_000) return hit.list;
  try {
    const list = await ctx.boxlite.listVolumes();
    volumeCache.set(ctx.boxlite, { at: Date.now(), list });
    return list;
  } catch {
    return null;
  }
}

export async function volumeViews(ctx: Pick<Ctx, 'boxlite'>, app: AppRow, env: EnvRow, spec: Spec | undefined): Promise<VolumeView[]> {
  const declared = spec?.volumes ?? [];
  if (!declared.length) return [];
  const remote = await boxliteVolumes(ctx);
  return declared.map((v) => {
    const name = volumeName(app.name, env.name, v.name);
    const r = remote?.find((x) => x.name === name);
    return { name: v.name, mountPath: v.mount, mode: v.mode, volumeName: name, volumeId: r?.id ?? null, sizeBytes: r?.sizeBytes ?? null, state: r?.state ?? null };
  });
}

// ---- summary / detail ----------------------------------------------------------------

export interface LiveState {
  box: string | null;
  services: ServiceState[];
}

/** BoxLite status of the env's Box (cached by Resources) and its services: probed when asked, else the last report. */
async function liveState(ctx: Ctx, env: EnvRow, opts: { probe?: boolean } = {}): Promise<LiveState> {
  if (opts.probe) {
    const { box, services } = await ctx.resources.liveServices(env);
    return { box, services };
  }
  const box = env.box_id ? await ctx.resources.boxStatus(env.box_id).catch(() => 'unknown') : null;
  return { box, services: storedServices(env) };
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
    previewSrc: (() => {
      const shot = main.live_deployment ? previewMeta(ctx, main.id) : null;
      return shot ? `/apps/${encodeURIComponent(app.name)}/preview?env=main&v=${encodeURIComponent(shot.capturedAt)}` : null;
    })(),
    visibility: ctx.resources.effectiveAccess(main),
    status,
    lastDeploy: lastDeploy(latest),
    resources: { database: !!main.db_url, storage: spec?.volumes.length ?? 0, users: null },
    createdAt: app.created_at,
    environments: envs.length,
    liveIn: envs.filter((e) => e.id !== main.id && e.live_deployment).map((e) => e.name),
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

/** The service's last error lines since the serving deployment started: earlier ones are history, not its trouble now. */
function recentErrors(ctx: Pick<Ctx, 'store'>, env: EnvRow, service: string): string[] {
  const serving = env.live_deployment ? ctx.store.deployment(env.id, env.live_deployment) : undefined;
  return ctx.store
    .logs(env.id, { source: service, limit: 200, ...(serving?.started_at ? { since: serving.started_at } : {}) })
    .filter((l) => logLevel(l.level) === 'error')
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
      // The fix itself is written for the agent (commands, files): it travels in fixPrompt.
      detail: `${failure.diagnosis.summary.charAt(0).toUpperCase()}${failure.diagnosis.summary.slice(1)}.`,
      fixPrompt: failure.fixPrompt,
      deployment: latest.number,
      ...(env.live_deployment && env.box_id ? { serving: releaseId(env.live_deployment) } : {}),
    });
  }
  if (reportedAny && env.live_deployment) {
    for (const s of services) {
      const looping = crashLooping(s);
      if (s.state !== 'failed' && s.health !== 'unhealthy' && !looping) continue;
      // Its own last words say more than any counter: "Error: SLACK_TOKEN is not set".
      const said = errorFocus(s.recentErrors, 1)[0]?.replace(/^\S+Z /, '');
      const exits = s.lastExitCode !== undefined ? `exited with code ${s.lastExitCode}` : 'stopped';
      out.push({
        summary: s.state === 'failed' ? `${s.name} has crashed` : looping ? `${s.name} keeps crashing` : `${s.name} is failing its health check`,
        detail:
          s.health === 'unhealthy' && !looping && s.state !== 'failed'
            ? `It answers ${s.healthPath ?? 'its health check'} with an error${said ? `: "${said}"` : ''}.`
            : `It ${exits}${said ? `: "${said}"` : ''}. Restarted ${s.restarts} time${s.restarts === 1 ? '' : 's'} so far.`,
        fixPrompt: `The service "${s.name}" of the BoxLite app "${app.name}" (environment ${env.name}) is ${s.state === 'failed' || looping ? 'crashing' : 'failing its health check'}.\nRead \`boxlite-app app logs --source ${s.name} --since 30m\` and \`boxlite-app app services\`, fix the cause, then deploy again.`,
        ...(said && missingVariableIn(said) ? { missingVariable: missingVariableIn(said) } : {}),
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
    const db = dbCoordinates(fresh.db_url);
    database = {
      status: 'ready',
      engine: 'Postgres',
      host: db.host,
      name: db.database,
      user: db.user,
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
  if (database && spec?.database) platformVariables.unshift({ name: 'DATABASE_URL', value: 'postgresql://•••• (managed by BoxLite; the app gets the full URL)', kind: 'Database' });
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

  refreshPreviewIfStale(ctx, app, fresh, state.box);
  const shot = fresh.live_deployment ? previewMeta(ctx, fresh.id) : null;

  return {
    id: app.name,
    appId: app.id,
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
      present: secretValue(ctx, app, from) !== undefined,
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
    preview: shot
      ? { src: `/apps/${encodeURIComponent(app.name)}/preview?env=${encodeURIComponent(fresh.name)}&v=${encodeURIComponent(shot.capturedAt)}`, capturedAt: shot.capturedAt, releaseId: releaseId(shot.deployment) }
      : null,
    previewAttempt: previewAttempt(fresh.id),
    handoffPrompt: handoffPrompt(ctx, app.name, key ? maskKey(key.last4) : '<rotate the key to get a new one>', undefined, fresh.name),
    key,
    specVersion: spec?.version ?? null,
    auth: endUserAuth.authStatus(ctx, app, fresh),
  };
}
