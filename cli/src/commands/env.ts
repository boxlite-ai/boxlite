import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';

async function envCreate(ctx: Ctx, name: string, opts: { from?: string; withData?: boolean }): Promise<void> {
  const env = await (await ctx.appApi()).createEnv({ name, from: opts.from ?? 'main', ...(opts.withData ? { with_data: true } : {}) });
  ctx.out.data(env);
  ctx.out.line(`environment ${name} created from ${opts.from ?? 'main'}${opts.withData ? ' with data' : ''}${env.url ? ` · ${env.url}` : ''}`);
  ctx.out.next(`\`boxlite-app deploy --env ${name}\``);
}

async function envDelete(ctx: Ctx, name: string): Promise<void> {
  const app = await ctx.appName();
  if (name === 'main') throw new MicrocloudError('forbidden', 'the main environment cannot be deleted', 'delete another environment, or roll main back with `boxlite-app app rollback <N>`');
  const api = (await ctx.appApi()).scoped(app, name);
  const env = await api.getEnv();
  // No spec yet is fine (nothing deployed); any other failure must stop here, or the brief would omit the volumes.
  const spec = await api.getSpec().catch((e: unknown) => {
    if (e instanceof MicrocloudError && e.code === 'not_found') return null;
    throw e;
  });
  const volumes = ((spec?.volumes as { name: string; mount: string }[] | undefined) ?? []).map((v) => `volume ${v.name} (${v.mount}) and every file in it`);
  const box = env.box as { id?: string } | null | undefined;
  const db = env.database as { branch?: string } | null | undefined;
  const ok = await ctx.confirmDestructive({
    action: `delete environment ${name} of ${app}`,
    destroys: [
      ...(box?.id ? [`Box ${box.id} with its releases`] : []),
      ...(db?.branch ? [`database branch ${db.branch} and all of its data`] : []),
      ...volumes,
      `the deployment history and logs of ${name}`,
      `the URL ${env.url ?? name}`,
    ],
    undo: 'none: this cannot be undone',
  });
  if (!ok) {
    ctx.out.line('cancelled');
    return;
  }
  await (await ctx.appApi()).deleteEnv(name);
  ctx.out.data({ deleted: name });
  ctx.out.line(`environment ${name} deleted`);
}

export function registerEnv(app: Command, make: MakeCtx): void {
  const env = app.command('env').description('environments (each has its own Box, database branch and volumes)');
  describe(
    env
      .command('create <name>')
      .description('create an environment from another one')
      .option('--from <env>', 'source environment', 'main')
      .option('--with-data', 'copy the database data too (default: schema only)')
      .action(async (name: string, opts: { from?: string; withData?: boolean }, cmd: Command) => envCreate(await make(cmd), name, opts)),
    { json: 'EnvSummary', exits: [2, 3], online: true },
  );
  describe(
    env
      .command('delete <name>')
      .description('delete an environment with its Box, database branch and volumes (destructive)')
      .option('-y, --yes', 'confirm')
      .action(async (name: string, _o: unknown, cmd: Command) => envDelete(await make(cmd), name)),
    { json: '{ deleted: string }', exits: [2, 3, 5, 10], destructive: true, online: true },
  );
}
