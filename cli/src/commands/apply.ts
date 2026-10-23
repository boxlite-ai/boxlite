import type { Command } from 'commander';
import type { MakeCtx } from '../cli.js';
import { updateLink, type Ctx } from '../context.js';
import { abortOnSigint, deployFailedError, followDeployment } from '../follow.js';
import { describe } from '../meta.js';
import { failureHints } from './deploy.js';
import { pad } from '../output.js';
import { runPlan } from './plan.js';

async function apply(ctx: Ctx, opts: { force?: boolean; message?: string }): Promise<void> {
  const { checked, plan } = await runPlan(ctx, opts.force === true);
  const changes = plan.changes ?? [];
  const applicable = changes.filter((c) => c.kind !== 'online_only');
  if (applicable.length === 0) {
    ctx.out.data({ applied: false, changes: [] });
    ctx.out.line('nothing to apply');
    ctx.out.next('`boxlite-app deploy` ships code changes');
    return;
  }
  if (!(await ctx.confirm(`Apply ${applicable.length} change${applicable.length === 1 ? '' : 's'} to ${await ctx.appName()}/${ctx.envName}?`, 'apply'))) {
    ctx.out.line('cancelled');
    return;
  }

  const api = await ctx.appApi();
  const deployment = await api.createDeployment({
    kind: 'apply',
    // The deployment list shows this text, so an apply always says what it changes.
    message: opts.message ?? `Apply ${applicable.map((c) => c.path.split('.')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`,
    manifest: checked.manifest,
    migrations: checked.migrations,
    base_version: ctx.baseVersion,
    ...(opts.force ? { force: true } : {}),
  });

  const { signal, dispose } = abortOnSigint();
  let result;
  try {
    result = await followDeployment(api, deployment.number, {}, signal);
  } finally {
    dispose();
  }
  if (result.aborted) {
    ctx.out.line(`stopped following; apply #${deployment.number} continues`);
    ctx.out.next(`\`boxlite-app app deployment ${deployment.number} --follow\``);
    return;
  }

  const final = result.deployment;
  // An apply readies resources; the app serves only once a deploy has shipped code. Say which.
  const env = result.status === 'live' ? await api.getEnv().catch(() => null) : null;
  const serving = Boolean((env?.live_deployment as { release?: number | null } | null | undefined)?.release);
  const added = applicable.filter((c) => c.kind === '+').map((c) => c.path);
  const summary = added.length > 0 ? `Provision ${added.join(', ')}` : `Apply ${applicable.map((c) => c.path).join(', ')}`;
  const status = result.status === 'live' ? 'applied' : result.status;
  const specText = final.spec_version !== undefined ? ` · spec v${final.spec_version}` : '';
  ctx.out.line(`#${final.number}  ${pad(summary, 50)}${status}${specText}`);
  if (result.status === 'live') ctx.out.line(serving ? `serving: ${final.url ?? 'the app URL'} (the code deployed before keeps running)` : 'not serving yet: resources are ready, but no code is deployed, so the URL shows "not live yet"');
  if (result.status === 'failed') {
    const full = await api.getDeployment(final.number).catch(() => final);
    throw deployFailedError({ ...final, ...full, error: full.error ?? final.error }, failureHints(checked));
  }
  ctx.out.data({ ...final, applied: true, serving });
  if (final.spec_version != null) await updateLink(ctx.cwd, { base_version: final.spec_version });
  ctx.out.next(serving ? '`boxlite-app deploy` ships code changes' : 'the app is not live until you `boxlite-app deploy` the code (`boxlite-app app dev` runs it locally against these resources first)');
}

export function registerApply(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('apply')
      .description('provision the resources in boxlite.toml (database, migrations, volumes, auth, variables) without uploading code')
      .option('-y, --yes', 'do not ask for confirmation')
      .option('--force', 'apply even when the local base version is behind the environment: overwrites changes made online; only when the user asks')
      .option('-m, --message <text>', 'description shown in the deployment list')
      .action(async (opts: { force?: boolean; message?: string }, cmd: Command) => apply(await make(cmd), opts)),
    { json: 'Deployment (kind "apply", status "live" = applied) & { applied: true, serving: boolean (false until a deploy has shipped code) }; nothing to do: { applied: false, changes: [] }', exits: [2, 3, 6, 7, 8, 9, 10], online: true },
  );
}
