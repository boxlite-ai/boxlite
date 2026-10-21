import { classifyFailure } from '@microcloud/shared';
import type { Command } from 'commander';
import type { Deployment, Timeline } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { abortOnSigint, followDeployment, TERMINAL_STATUSES } from '../follow.js';
import { describe } from '../meta.js';
import { formatAgo, formatMs, pad, stepLine, table } from '../output.js';
import { parseInteger, readLocalProject } from './common.js';
import { failureHints, finishDeployment, followPrinter } from './deploy.js';

async function deployments(ctx: Ctx, opts: { limit?: string }): Promise<void> {
  const list = await (await ctx.appApi()).listDeployments(opts.limit !== undefined ? parseInteger(opts.limit, '--limit') : undefined);
  ctx.out.data(list);
  if (list.length === 0) {
    ctx.out.line('no deployments');
    ctx.out.next('`boxlite-app deploy`');
    return;
  }
  const rows = list.map((d) => [`#${d.number}`, d.kind, d.status, d.spec_version != null ? `v${d.spec_version}` : '', formatAgo(d.created_at), d.message ?? '']);
  for (const line of table(rows)) ctx.out.line(line);
  const failed = list[0]?.status === 'failed' ? list[0] : undefined;
  if (failed) ctx.out.next(`\`boxlite-app app deployment ${failed.number} --logs\` shows why #${failed.number} failed`);
}

/** Diagnosis of a failed deployment for inspection commands (they succeed: the inspection worked). */
async function diagnosisOf(ctx: Ctx, d: Deployment, extraTail: string[] = []) {
  if (d.status !== 'failed' || !d.error) return null;
  const local = await readLocalProject(ctx);
  return classifyFailure({ ...failureHints(local), step: d.error.step, message: d.error.message, log_tail: [...(d.error.log_tail ?? []), ...(d.log_tail ?? []), ...extraTail], deployment: d.number });
}

function clock(iso: string | null | undefined): string {
  return iso ? iso.slice(11, 19) : '        ';
}

function printTimeline(ctx: Ctx, t: Timeline): void {
  const d = t.deployment;
  ctx.out.line(`#${d.number}  ${d.kind} · ${d.status}${d.message ? ` · ${d.message}` : ''} · created ${d.created_at ?? ''}`);
  ctx.out.line('');
  ctx.out.line('Steps');
  for (const s of t.steps) ctx.out.line(`  ${clock(s.started_at)}  ${pad(s.name, 9)} ${pad(s.status, 8)} ${pad(formatMs(s.ms), 7)} ${s.detail ?? ''}`.trimEnd());
  ctx.out.line('');
  ctx.out.line(`Log (${t.logs.length} lines${t.truncated ? ', oldest dropped' : ''})`);
  for (const l of t.logs) ctx.out.line(`  ${clock(l.ts)}  ${pad(l.source, 7)} ${l.level === 'error' ? '! ' : ''}${l.line}`);
  ctx.out.line('');
  ctx.out.line(`Status: ${d.status}${d.finished_at ? ` at ${d.finished_at}` : ''}${d.url && d.status === 'live' ? ` · ${d.url}` : ''}`);
}

async function deployment(ctx: Ctx, nText: string, opts: { follow?: boolean; logs?: boolean; cancel?: boolean; verbose?: boolean }): Promise<void> {
  const n = parseInteger(nText, 'deployment number');
  const api = await ctx.appApi();
  if (opts.cancel) {
    const d = await api.cancelDeployment(n);
    ctx.out.data(d);
    ctx.out.line(`#${n}  ${d.status ?? 'cancelled'}`);
    ctx.out.next('`boxlite-app app deployments`');
    return;
  }
  if (opts.logs && !opts.follow) {
    const t = await api.deploymentTimeline(n);
    const diagnosis = await diagnosisOf(ctx, t.deployment, t.logs.slice(-200).map((l) => `${l.ts} [${l.source}] ${l.line}`));
    ctx.out.data({ ...t, diagnosis });
    printTimeline(ctx, t);
    if (diagnosis) {
      ctx.out.line(`Cause: ${diagnosis.cause} — ${diagnosis.summary}${diagnosis.file ? ` (${diagnosis.file}${diagnosis.line !== undefined ? `:${diagnosis.line}` : ''})` : ''}`);
      ctx.out.next(diagnosis.fix);
    }
    return;
  }

  const d = await api.getDeployment(n);
  if (opts.follow && !TERMINAL_STATUSES.has(d.status)) {
    ctx.out.line(`#${n}  ${d.kind} · ${d.status}${d.message ? ` · ${d.message}` : ''}`);
    const local = await readLocalProject(ctx);
    const printer = followPrinter(ctx, n, local, { verbose: opts.verbose || opts.logs });
    const { signal, dispose } = abortOnSigint();
    try {
      await finishDeployment(ctx, api, await followDeployment(api, n, printer, signal), n, printer, local);
    } finally {
      dispose();
    }
    return;
  }

  const diagnosis = await diagnosisOf(ctx, d);
  ctx.out.data({ ...d, diagnosis });
  ctx.out.line(`#${n}  ${d.kind} · ${d.status}${d.spec_version != null ? ` · spec v${d.spec_version}` : ''}${d.message ? ` · ${d.message}` : ''}${d.created_at ? ` · ${formatAgo(d.created_at)}` : ''}`);
  for (const s of d.steps ?? []) ctx.out.line(`  ${stepLine(n, s.name, s.detail ?? '', s.ms, s.status === 'failed' ? 'failed' : undefined)}${s.status !== 'failed' && s.status !== 'done' ? `   ${s.status}` : ''}`);
  if (d.url) ctx.out.line(`  url: ${d.url}`);
  if (d.error) ctx.out.line(`  error: ${d.error.step ? `[${d.error.step}] ` : ''}${d.error.message ?? ''}`);
  if (diagnosis) {
    ctx.out.line(`  cause: ${diagnosis.cause} — ${diagnosis.summary}`);
    for (const e of diagnosis.evidence) ctx.out.line(`    ${e}`);
    ctx.out.next(diagnosis.fix);
  } else if (!TERMINAL_STATUSES.has(d.status)) ctx.out.next(`\`boxlite-app app deployment ${n} --follow\``);
  else ctx.out.next(`\`boxlite-app app deployment ${n} --logs\` for the full timeline`);
}

async function rollback(ctx: Ctx, nText: string, opts: { withDatabase?: boolean }): Promise<void> {
  const to = parseInteger(nText, 'deployment number');
  const app = await ctx.appName();
  if (opts.withDatabase) {
    const ok = await ctx.confirmDestructive({
      action: `roll ${app}/${ctx.envName} back to #${to} and restore its database`,
      destroys: [`every database change made after the first migration that followed #${to} (rows written since then are lost)`, `the release now serving ${ctx.envName}`],
      undo: `the current database is kept as Neon branch ${ctx.envName}-before-rollback-<N>; roll forward with \`boxlite-app deploy\``,
    });
    if (!ok) {
      ctx.out.line('cancelled');
      return;
    }
  }
  const api = await ctx.appApi();
  const d = await api.createDeployment({ kind: 'rollback', to, ...(opts.withDatabase ? { with_database: true } : {}) });
  ctx.out.line(`Rollback #${d.number} → release of #${to} started`);
  const printer = followPrinter(ctx, d.number, null);
  const { signal, dispose } = abortOnSigint();
  try {
    await finishDeployment(ctx, api, await followDeployment(api, d.number, printer, signal), d.number, printer);
  } finally {
    dispose();
  }
}

export function registerDeployments(app: Command, make: MakeCtx): void {
  describe(
    app
      .command('deployments')
      .description('recent deployments of the environment')
      .option('--limit <n>', 'how many (default 20)')
      .action(async (opts: { limit?: string }, cmd: Command) => deployments(await make(cmd), opts)),
    { json: 'Deployment[] (newest first)', exits: [2, 3], online: true },
  );
  describe(
    app
      .command('deployment <n>')
      .description('one deployment: steps, error with classified cause; --logs: full timeline with step timestamps and every log line')
      .option('--follow', 'follow a running deployment until it finishes (exit 8 if it fails)')
      .option('--logs', 'full timeline: steps with timestamps and durations, build and start log, final status')
      .option('-v, --verbose', 'with --follow: stream log lines')
      .option('--cancel', 'cancel a queued or building deployment')
      .action(async (n: string, opts: { follow?: boolean; logs?: boolean; cancel?: boolean; verbose?: boolean }, cmd: Command) => deployment(await make(cmd), n, opts)),
    {
      json: 'Deployment & { diagnosis: Diagnosis | null }; --logs: { deployment, steps: { name, status, detail, ms, started_at, finished_at }[], logs: LogLine[], truncated, diagnosis }',
      exits: [2, 3, 4, 8],
      online: true,
      examples: ['boxlite-app app deployment 7 --logs', 'boxlite-app app deployment 7 --follow'],
    },
  );
  describe(
    app
      .command('rollback <n>')
      .description('switch the environment back to the release of deployment N (one of the last 3 on the Box)')
      .option('--with-database', 'also restore the database to its state before the first later migration (destructive)')
      .option('-y, --yes', 'confirm --with-database')
      .action(async (n: string, opts: { withDatabase?: boolean }, cmd: Command) => rollback(await make(cmd), n, opts)),
    { json: 'Deployment (kind "rollback")', exits: [2, 3, 4, 8, 10], destructive: true, online: true },
  );
}
