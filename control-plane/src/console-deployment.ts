import { classifyFailure, exposedService, type Diagnosis } from '@microcloud/shared';
import type { AppRow, Change, Deployment, EnvRow, SnapshotFile } from './db.js';
import type { Ctx } from './ctx.js';

/**
 * The console's deployment detail: a traceable timeline of one deployment (steps with start and
 * duration, every log line), what it changed (infrastructure and configuration from the CP's diff,
 * code as file counts against the previous upload) and, for a failure, the classified cause from
 * shared/diagnose.ts with instructions an agent can act on.
 */

export interface TimelineStep {
  name: string;
  status: string;
  ms?: number;
  detail?: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface TimelineLog {
  id: number;
  ts: string;
  source: string;
  level: string;
  line: string;
  deployment: number | null;
}

/** GET /v1/…/deployments/:n/timeline (routes/cli-extras.ts). */
export interface Timeline {
  steps: TimelineStep[];
  logs: TimelineLog[];
  truncated: boolean;
}

export interface CodeChanges {
  added: number;
  changed: number;
  removed: number;
  files: number;
  /** The deployment whose upload this one is compared with; null for the first upload. */
  comparedWith: number | null;
}

export interface DeploymentChanges {
  infrastructure: string[];
  configuration: string[];
  code: CodeChanges | null;
}

export interface FailureView {
  step: string;
  message: string;
  diagnosis: Diagnosis;
  /** Self-contained instructions to paste into the agent. */
  fixPrompt: string;
}

/** CP diff paths that describe what the app runs on; the rest is configuration. */
const INFRASTRUCTURE = /^(runtime|service|services|schedule|schedules|volume|volumes|database|migrations|auth|domains)\b/;

export function changeText(c: Change): string {
  const v = (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x));
  if (c.kind === '~' && c.from !== undefined && c.to !== undefined) return `~ ${c.path}: ${v(c.from)} → ${v(c.to)}`;
  if (c.kind === '+' && c.to !== undefined && typeof c.to !== 'object') return `+ ${c.path} = ${v(c.to)}`;
  if (c.kind === 'online_only') return `online ${c.path}: ${v(c.to)}`;
  return `${c.kind} ${c.path}`;
}

function codeChanges(ctx: Pick<Ctx, 'store'>, app: AppRow, env: EnvRow, d: Deployment): CodeChanges | null {
  if (!d.snapshot_id) return null;
  const snap = ctx.store.snapshot(app.id, d.snapshot_id);
  if (!snap) return null;
  const prev = ctx.store.deploymentsWhere('env_id = ? AND number < ? AND snapshot_id IS NOT NULL ORDER BY number DESC LIMIT 1', env.id, d.number)[0];
  const before = new Map<string, string>((prev?.snapshot_id ? (ctx.store.snapshot(app.id, prev.snapshot_id)?.manifest ?? []) : []).map((f: SnapshotFile) => [f.path, f.sha256]));
  let added = 0;
  let changed = 0;
  for (const f of snap.manifest) {
    const old = before.get(f.path);
    if (old === undefined) added++;
    else if (old !== f.sha256) changed++;
    before.delete(f.path);
  }
  return { added, changed, removed: before.size, files: snap.files, comparedWith: prev?.number ?? null };
}

export function deploymentChanges(ctx: Pick<Ctx, 'store'>, app: AppRow, env: EnvRow, d: Deployment): DeploymentChanges {
  const infrastructure: string[] = [];
  const configuration: string[] = [];
  for (const c of d.changes) (INFRASTRUCTURE.test(c.path) ? infrastructure : configuration).push(changeText(c));
  return { infrastructure, configuration, code: codeChanges(ctx, app, env, d) };
}

/** Log lines of a deployment in the form the classifier reads (`<ts> [<source>] <line>`). */
function logLines(ctx: Pick<Ctx, 'store'>, env: EnvRow, d: Deployment): string[] {
  const own = ctx.store.logs(env.id, { deployment: d.number, limit: 400 });
  const rel = d.release && d.release !== d.number ? ctx.store.logs(env.id, { deployment: d.release, since: d.started_at ?? d.created_at, limit: 400 }) : [];
  return [...own, ...rel]
    .filter((l) => !d.finished_at || l.ts <= d.finished_at)
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    .map((l) => `${l.ts} [${l.source}] ${l.line}`);
}

function fixPrompt(app: AppRow, env: EnvRow, d: Deployment, step: string, diagnosis: Diagnosis): string {
  const lines = [
    `Deployment #${d.number} of the BoxLite app "${app.name}" (environment ${env.name}) failed at step "${step}".`,
    `Cause: ${diagnosis.summary}`,
    `Fix: ${diagnosis.fix}`,
  ];
  if (diagnosis.file) lines.push(`File: ${diagnosis.file}${diagnosis.line !== undefined ? `:${diagnosis.line}` : ''}`);
  if (diagnosis.evidence.length) lines.push('Log lines:', ...diagnosis.evidence.map((l) => `  ${l}`));
  lines.push(`Full timeline: \`boxlite-app app deployment ${d.number} --logs${env.name === 'main' ? '' : ` --env ${env.name}`}\`.`);
  return lines.join('\n');
}

/** null unless the deployment failed. */
export function failureView(ctx: Pick<Ctx, 'store'>, app: AppRow, env: EnvRow, d: Deployment): FailureView | null {
  if (d.status !== 'failed' || !d.error) return null;
  const manifest = d.request.manifest;
  const exposed = manifest ? exposedService(manifest) : undefined;
  const diagnosis = classifyFailure({
    step: d.error.step,
    message: d.error.message,
    log_tail: [...(d.error.log_tail ?? []), ...logLines(ctx, env, d)],
    deployment: d.number,
    ...(exposed ? { service: { name: exposed.name, ...(exposed.command ? { command: exposed.command } : {}), ...(exposed.health ? { health: exposed.health } : {}) } } : {}),
    ...(d.request.migrations ? { migrations: d.request.migrations } : {}),
    ...(manifest?.database ? { migrationsDir: manifest.database.migrations } : {}),
    ...(manifest ? { build: manifest.runtime.build } : {}),
  });
  return { step: d.error.step, message: d.error.message, diagnosis, fixPrompt: fixPrompt(app, env, d, d.error.step, diagnosis) };
}

/** When the step running now began, from the stored step events. */
export function runningStepStartedAt(ctx: Pick<Ctx, 'store'>, env: EnvRow, d: Deployment): string | null {
  const running = d.steps.find((s) => s.status === 'running');
  if (!running) return null;
  const rows = ctx.store.all<{ data: string; ts: string }>("SELECT data, ts FROM deployment_events WHERE env_id = ? AND number = ? AND event = 'step' ORDER BY seq DESC", env.id, d.number);
  for (const r of rows) {
    const ev = JSON.parse(r.data) as { name: string; status: string };
    if (ev.name === running.name && ev.status === 'running') return r.ts;
  }
  return null;
}
