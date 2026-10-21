import { checkProject, type CheckResult } from '@microcloud/shared';
import type { Command } from 'commander';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { checkLines, checkSummary } from '../output.js';
import { invalidManifestError, planRequest } from './common.js';

async function check(ctx: Ctx, opts: { online?: boolean }): Promise<void> {
  const checked = await checkProject(ctx.cwd, ctx.envName);
  let result: CheckResult = checked.result;

  if (opts.online && checked.manifest && checked.upload && checked.source !== null) {
    const plan = await (await ctx.appApi()).plan(planRequest(ctx, { manifest: checked.manifest, upload: checked.upload, migrations: checked.migrations, result, source: checked.source }));
    const errors = [...result.errors, ...(plan.errors ?? [])];
    result = { ok: errors.length === 0, errors, warnings: [...result.warnings, ...(plan.warnings ?? [])] };
  }

  for (const line of checkLines(result)) ctx.out.line(line);
  ctx.out.line(checkSummary(result));
  if (!result.ok) throw invalidManifestError(result, !ctx.json);
  ctx.out.data(result);
  ctx.out.next(opts.online ? '`boxlite-app deploy -m "<what changed>"`' : '`boxlite-app plan` shows what changes online');
}

export function registerCheck(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('check')
      .description('validate boxlite.toml and the project locally (no network); exit 7 on errors')
      .option('--online', 'also ask the control plane (/plan) and merge its errors')
      .action(async (opts: { online?: boolean }, cmd: Command) => check(await make(cmd), opts)),
    {
      json: '{ ok: true, errors: [], warnings: { rule, message }[] }; on errors (exit 7, stderr): { error: { code: "invalid_manifest", errors: { file, line?, rule, message }[], warnings } }',
      exits: [7],
      online: false,
    },
  );
}
