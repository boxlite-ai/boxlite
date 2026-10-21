import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import type { PlanResponse } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { fixCommandReferences } from '../guidance.js';
import { describe } from '../meta.js';
import { formatChange, pad } from '../output.js';
import { invalidManifestError, planRequest, requireCheck, uploadSummary, type CheckedProject } from './common.js';

export interface PlanOutcome {
  checked: CheckedProject;
  plan: PlanResponse;
}

export function staleError(plan: PlanResponse, baseVersion: number): MicrocloudError {
  return new MicrocloudError('stale_base', `boxlite.toml is based on spec v${baseVersion} but the environment is at v${plan.latest_version}`, 'run `boxlite-app app pull` (keeps boxlite.toml.bak), re-apply your edits, then plan again; or pass --force to overwrite the online changes', {
    base_version: baseVersion,
    latest_version: plan.latest_version,
    changes: plan.changes,
  });
}

/** check → POST /plan → print the plan; throws on manifest errors (7) and stale base (9, unless forced). */
export async function runPlan(ctx: Ctx, force: boolean): Promise<PlanOutcome> {
  const checked = await requireCheck(ctx);
  const api = await ctx.appApi();
  const plan = await api.plan(planRequest(ctx, checked, force));
  const app = await ctx.appName();
  const warnings = [...checked.result.warnings, ...(plan.warnings ?? [])].map((w) => ({ ...w, message: fixCommandReferences(w.message) }));

  ctx.out.data({ app, environment: ctx.envName, base_version: ctx.baseVersion, ...plan, upload: { files: checked.upload.files.length, bytes: checked.upload.bytes }, warnings });
  ctx.out.line(`App ${app} · environment ${ctx.envName} · based on v${ctx.baseVersion} (latest v${plan.latest_version})${plan.stale ? ' · stale' : ''}`);
  for (const c of plan.changes ?? []) ctx.out.line(formatChange(c));
  if ((plan.changes ?? []).length === 0) ctx.out.line('  (no changes)');
  ctx.out.line(`  ${pad('files to upload', 18)}${uploadSummary(checked)}`);
  for (const w of plan.warnings ?? []) ctx.out.line(`  warning  ${w.rule}  ${fixCommandReferences(w.message)}`);
  if (plan.errors?.length) {
    const result = { ok: false, errors: plan.errors, warnings: plan.warnings ?? [] };
    if (!ctx.json) for (const e of plan.errors) ctx.out.line(`${e.file}${e.line !== undefined ? `:${e.line}` : ''}  ${e.rule}  ${e.message}`);
    throw invalidManifestError(result, !ctx.json);
  }
  if (plan.stale && !force) throw staleError(plan, ctx.baseVersion);
  return { checked, plan };
}

export function registerPlan(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('plan')
      .description('show what apply/deploy would change in this environment (exit 9 when boxlite.toml is stale)')
      .option('--force', 'plan even when the local base version is behind the environment')
      .action(async (opts: { force?: boolean }, cmd: Command) => {
        const ctx = await make(cmd);
        const { plan } = await runPlan(ctx, opts.force === true);
        const real = (plan.changes ?? []).filter((c) => c.kind !== 'online_only');
        const code = real.some((c) => !c.path.startsWith('migrations/') && ['database', 'volume', 'auth', 'variables', 'secrets', 'access'].some((p) => c.path.startsWith(p)));
        if (!real.length) ctx.out.next('nothing to change online; `boxlite-app deploy` ships code changes');
        else ctx.out.next(code ? '`boxlite-app apply --yes` provisions these now (no code upload), or `boxlite-app deploy` does it with the code' : '`boxlite-app deploy -m "<what changed>"`');
      }),
    {
      json: '{ app, environment, base_version, latest_version, stale, changes: { kind: "+"|"~"|"-"|"online_only", path, from?, to? }[], errors: CheckError[], warnings: CheckWarning[], upload: { files, bytes } }',
      exits: [2, 3, 6, 7, 9],
      online: true,
    },
  );
}
