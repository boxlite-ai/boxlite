import { exposedService, formatBytes } from '@microcloud/shared';
import type { Command } from 'commander';
import type { Api, Deployment, LogEvent, StepEvent } from '../api.js';
import type { MakeCtx } from '../cli.js';
import { updateLink, type Ctx } from '../context.js';
import { abortOnSigint, deployFailedError, FAILURE_TAIL, followDeployment, type FailureHints, type FollowResult } from '../follow.js';
import { describe } from '../meta.js';
import { stepLabel, stepLine } from '../output.js';
import { uploadSnapshot } from '../upload.js';
import { requireCheck, type CheckedProject } from './common.js';
import { runPlan } from './plan.js';

/** Human detail for a step when the event carries none; derived from the local manifest. */
export function stepDetail(ev: StepEvent, checked: CheckedProject | null, uploaded?: number): string {
  if (ev.detail) return ev.detail;
  if (!checked) return '';
  const m = checked.manifest;
  switch (ev.name) {
    case 'upload':
      return uploaded !== undefined ? `${uploaded} files` : `${checked.upload.files.length} files`;
    case 'build':
      return m.runtime.build.length > 0 ? m.runtime.build.join(' && ') : '(no build step)';
    case 'migrate':
      return m.database ? `${checked.migrations.length} file${checked.migrations.length === 1 ? '' : 's'} in ${m.database.migrations}` : '';
    case 'start': {
      const svc = exposedService(m);
      return svc ? (svc.command ? `${svc.name}  ${svc.command}` : `${svc.name}  static ${svc.static}`) : '';
    }
    default:
      return '';
  }
}

/** What the classifier can only know from the local project. */
export function failureHints(checked: CheckedProject | null): FailureHints {
  if (!checked) return {};
  const svc = exposedService(checked.manifest);
  return {
    service: svc ? { name: svc.name, command: svc.command, health: svc.health } : undefined,
    migrations: checked.migrations.map((m) => ({ file: m.file, sql: m.sql })),
    migrationsDir: checked.manifest.database?.migrations,
    build: checked.manifest.runtime.build,
  };
}

export interface FollowPrinter {
  onStep: (ev: StepEvent) => void;
  onLog: (ev: LogEvent) => void;
  logTail: string[];
}

/** Prints `#N  Building    npm ci && npm run build   41s` as steps finish; `verbose` also streams log lines. */
export function followPrinter(ctx: Ctx, number: number, checked: CheckedProject | null, opts: { verbose?: boolean; uploaded?: number } = {}): FollowPrinter {
  const logTail: string[] = [];
  return {
    logTail,
    onStep(ev) {
      if (ev.status === 'running') {
        if (opts.verbose) ctx.out.line(`#${number}  ${stepLabel(ev.name)} …`);
        else ctx.out.progress(`#${number}  ${stepLabel(ev.name)} …`);
      } else ctx.out.line(stepLine(number, ev.name, stepDetail(ev, checked, opts.uploaded), ev.ms, ev.status));
    },
    onLog(ev) {
      logTail.push(`${ev.ts ? `${ev.ts} ` : ''}[${ev.source ?? 'log'}] ${ev.line}`);
      if (logTail.length > FAILURE_TAIL) logTail.shift();
      if (opts.verbose) ctx.out.line(`    ${ev.source ? `${ev.source} | ` : ''}${ev.line}`);
    },
  };
}

/** Final line for a finished deployment plus link.json update; throws a classified `deploy_failed` (exit 8). */
export async function finishDeployment(ctx: Ctx, api: Api, result: FollowResult, number: number, printer: FollowPrinter, checked: CheckedProject | null = null): Promise<Deployment | null> {
  if (result.aborted) {
    ctx.out.line(`stopped following; deployment #${number} continues`);
    ctx.out.next(`\`boxlite-app app deployment ${number} --follow\``);
    return null;
  }
  const final = result.deployment;
  if (result.status === 'failed') {
    // The detail view carries the last 50 log lines across build, services and system.
    const full = await api.getDeployment(number).catch(() => final);
    if (!full.log_tail?.length) full.log_tail = printer.logTail;
    throw deployFailedError({ ...final, ...full, error: full.error ?? final.error }, failureHints(checked));
  }
  ctx.out.data(final);
  if (result.status === 'live') {
    ctx.out.line(stepLine(number, 'live', `${final.url ?? ''}${final.spec_version != null ? ` · spec v${final.spec_version}` : ''}`.trim()));
    if (final.spec_version != null) await updateLink(ctx.cwd, { base_version: final.spec_version });
    const svc = checked ? exposedService(checked.manifest) : undefined;
    if (final.url) ctx.out.next(`verify it: \`boxlite-app app curl ${svc?.health ?? '/'}\` and the pages the user asked for (\`--as qa@example.com\` for signed-in pages); \`boxlite-app app logs --since 5m\` shows what the app printed`);
  } else {
    ctx.out.line(`#${number}  ${result.status}`);
  }
  return final;
}

/** check + plan + upload size, without uploading or deploying. */
async function dryRun(ctx: Ctx, opts: { force?: boolean }): Promise<void> {
  const { checked, plan } = await runPlan(ctx, opts.force === true);
  const api = await ctx.appApi();
  const { missing } = await api.createUpload(checked.upload.files);
  const need = new Set(missing);
  const fresh = checked.upload.files.filter((f) => need.has(f.sha256));
  const freshBytes = [...new Map(fresh.map((f) => [f.sha256, f.size])).values()].reduce((n, b) => n + b, 0);
  const upload = { files: checked.upload.files.length, bytes: checked.upload.bytes, new_files: fresh.length, new_bytes: freshBytes };
  ctx.out.data({ dry_run: true, app: await ctx.appName(), environment: ctx.envName, base_version: ctx.baseVersion, ...plan, upload, warnings: [...checked.result.warnings, ...(plan.warnings ?? [])] });
  ctx.out.line(`  upload            ${upload.new_files} of ${upload.files} files are new (${formatBytes(upload.new_bytes)} of ${formatBytes(upload.bytes)})`);
  ctx.out.line('dry run: nothing was uploaded or deployed');
  ctx.out.next('`boxlite-app deploy -m "<what changed>"`');
}

async function deploy(ctx: Ctx, opts: { message?: string; detach?: boolean; force?: boolean; dryRun?: boolean; verbose?: boolean }): Promise<void> {
  if (opts.dryRun) return dryRun(ctx, opts);
  const checked = await requireCheck(ctx);
  const api = await ctx.appApi();

  const upload = await uploadSnapshot(api, ctx.cwd, checked.upload, (p) => {
    if (p.done === 0) ctx.out.line(p.total === 0 ? 'Nothing new to upload' : `Uploading ${p.total} files changed (${formatBytes(p.bytes)})`);
    else ctx.out.progress(`  ${p.done}/${p.total} uploaded`);
  });
  ctx.out.clearProgress();

  const deployment = await api.createDeployment({
    kind: 'deploy',
    snapshot_id: upload.snapshot_id,
    manifest: checked.manifest,
    migrations: checked.migrations,
    base_version: ctx.baseVersion,
    ...(opts.message ? { message: opts.message } : {}),
    ...(opts.force ? { force: true } : {}),
  });
  const number = deployment.number;

  if (opts.detach) {
    ctx.out.line(`Deployment #${number} started (detached)`);
    ctx.out.data(deployment);
    ctx.out.next(`\`boxlite-app app deployment ${number} --follow\``);
    return;
  }
  ctx.out.line(`Deployment #${number} started${opts.message ? ` · ${opts.message}` : ''}`);

  const printer = followPrinter(ctx, number, checked, { uploaded: upload.uploaded, verbose: opts.verbose });
  const { signal, dispose } = abortOnSigint();
  let result: FollowResult;
  try {
    result = await followDeployment(api, number, printer, signal);
  } finally {
    dispose();
  }
  await finishDeployment(ctx, api, result, number, printer, checked);
}

export function registerDeploy(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('deploy')
      .description('upload the project, build and start it on the environment, and follow the deployment until it is live or failed')
      .option('-m, --message <text>', 'deployment message')
      .option('--detach', 'return as soon as the deployment is queued')
      .option('--force', 'deploy even when the local base version is behind the environment: overwrites changes made online; only when the user asks')
      .option('--dry-run', 'check + plan + upload size; upload and deploy nothing')
      .option('-v, --verbose', 'stream build and start log lines as they arrive')
      .option('-y, --yes', 'accepted for symmetry with apply; deploy never prompts')
      .action(async (opts: { message?: string; detach?: boolean; force?: boolean; dryRun?: boolean; verbose?: boolean }, cmd: Command) => deploy(await make(cmd), opts)),
    {
      json: 'Deployment (status "live"); --dry-run: { dry_run: true, app, environment, base_version, latest_version, stale, changes, errors, warnings, upload: { files, bytes, new_files, new_bytes } }; failure (exit 8, stderr): { error: { code: "deploy_failed", deployment, step, cause, fix, file?, line?, evidence, log_tail } }',
      exits: [2, 3, 6, 7, 8, 9],
      online: true,
      examples: ['boxlite-app deploy -m "add deals board"', 'boxlite-app deploy --dry-run --json', 'boxlite-app deploy --verbose'],
    },
  );
}
