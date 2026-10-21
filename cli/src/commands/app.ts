import { ACCESS_LEVELS, MANIFEST_FILE, MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import type { MakeCtx } from '../cli.js';
import { updateLink, writeLink, type Ctx } from '../context.js';
import { describe } from '../meta.js';
import { table } from '../output.js';
import { contextMarkdown } from '../render/context-markdown.js';
import { specToToml } from '../toml-edit.js';
import { parseInteger } from './common.js';
import { registerCurl } from './curl.js';
import { registerDb } from './db.js';
import { registerDeployments } from './deployments.js';
import { registerDev } from './dev.js';
import { registerEnv } from './env.js';
import { registerLogs } from './logs.js';
import { registerSchedule } from './schedule.js';
import { registerVars } from './vars.js';
import { registerVolume } from './volume.js';

async function status(ctx: Ctx): Promise<void> {
  const api = await ctx.appApi();
  const info = await api.getApp(await ctx.appName());
  ctx.out.data(info);
  ctx.out.line(`App ${info.name}`);
  const envs = info.envs ?? [];
  const rows = envs.map((e) => {
    const d = e.latest_deployment;
    return [e.name, e.status ?? '', e.url ?? '', d ? `#${d.number} ${d.status}` : 'no deployments', e.spec_version != null ? `spec v${e.spec_version}` : ''];
  });
  for (const line of table(rows, '  ')) ctx.out.line(line);
  const current = envs.find((e) => e.name === ctx.envName);
  const latest = current?.latest_deployment;
  if (!latest) ctx.out.next('`boxlite-app check`, then `boxlite-app deploy -m "first version"`');
  else if (latest.status === 'failed') ctx.out.next(`\`boxlite-app app deployment ${latest.number} --logs\` shows why #${latest.number} failed`);
  else ctx.out.next('`boxlite-app app context` for services, schema, variables and recent errors');
}

async function context(ctx: Ctx, opts: { format?: string }): Promise<void> {
  if (opts.format && opts.format !== 'json' && opts.format !== 'markdown') throw new MicrocloudError('usage', `--format must be markdown or json (got "${opts.format}")`, 'use `boxlite-app app context --format markdown` or `--json`');
  const data = await (await ctx.appApi()).envContext();
  if (ctx.json || opts.format === 'json') {
    if (ctx.json) ctx.out.data(data);
    else ctx.out.raw(JSON.stringify(data, null, 2));
    return;
  }
  ctx.out.raw(contextMarkdown(data));
}

async function services(ctx: Ctx): Promise<void> {
  const list = await (await ctx.appApi()).listServices();
  ctx.out.data(list);
  if (!list.length) {
    ctx.out.line('no services running yet');
    ctx.out.next('`boxlite-app deploy`');
    return;
  }
  const rows = list.map((s) => [s.name, s.state, s.health ?? '', s.restarts !== undefined ? `restarts ${s.restarts}` : '', s.last_exit_code != null ? `exit ${s.last_exit_code}` : '', s.pid != null ? `pid ${s.pid}` : '']);
  for (const line of table(rows)) ctx.out.line(line);
  const bad = list.find((s) => s.state === 'failed' || (s.restarts ?? 0) > 3 || s.health === 'unhealthy');
  if (bad) ctx.out.next(`\`boxlite-app app logs --source ${bad.name} --level error --since 1h\``);
}

async function restart(ctx: Ctx, service?: string): Promise<void> {
  const api = await ctx.appApi();
  const names = service ? [service] : (await api.listServices()).map((s) => s.name);
  for (const name of names) {
    await api.restartService(name);
    ctx.out.line(`restarted ${name}`);
  }
  ctx.out.data({ restarted: names });
  if (names.length) ctx.out.next('`boxlite-app app services` to see them come back healthy');
}

async function access(ctx: Ctx, action?: string, value?: string): Promise<void> {
  const api = await ctx.appApi();
  if (action === undefined) {
    const current = await api.getAccess();
    ctx.out.data(current);
    ctx.out.line(`access ${current.access}${(current as { source?: string }).source === 'online' ? ' (set online; overrides boxlite.toml)' : ''}`);
    return;
  }
  if (action === 'clear') {
    const updated = await api.setAccess(null);
    ctx.out.data(updated);
    ctx.out.line(`access ${updated.access} (from boxlite.toml)`);
    return;
  }
  if (action !== 'set' || !value) throw new MicrocloudError('usage', 'expected `app access`, `app access set private|org|public` or `app access clear`', 'show it with `boxlite-app app access`');
  if (!(ACCESS_LEVELS as readonly string[]).includes(value)) throw new MicrocloudError('usage', `access must be one of ${ACCESS_LEVELS.join(', ')} (got "${value}")`, '`boxlite-app app access set private`');
  if (value === 'public') {
    const app = await ctx.appName();
    const ok = await ctx.confirmDestructive({
      action: `make ${app}/${ctx.envName} public`,
      destroys: ['the access gate: anyone on the internet with the URL can open the app', 'sign-in still applies to [auth].protect paths only'],
      undo: '`boxlite-app app access set private`',
    });
    if (!ok) {
      ctx.out.line('cancelled');
      return;
    }
  }
  const updated = await api.setAccess(value);
  ctx.out.data(updated);
  ctx.out.line(`access ${updated.access ?? value}`);
}

async function pull(ctx: Ctx): Promise<void> {
  const spec = await (await ctx.appApi()).getSpec();
  const path = join(ctx.cwd, MANIFEST_FILE);
  let backedUp = false;
  try {
    await readFile(path);
    await rename(path, `${path}.bak`);
    backedUp = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await writeFile(path, specToToml(spec));
  const version = typeof spec.version === 'number' ? spec.version : undefined;
  if (version !== undefined) await updateLink(ctx.cwd, { base_version: version });
  ctx.out.data({ file: MANIFEST_FILE, version, backup: backedUp ? `${MANIFEST_FILE}.bak` : null });
  ctx.out.line(`wrote boxlite.toml from spec v${version ?? '?'}${backedUp ? ' (previous file kept as boxlite.toml.bak, including any [env.*] overrides and comments)' : ''}`);
  ctx.out.next(backedUp ? 'diff boxlite.toml.bak boxlite.toml, re-apply your local edits, then `boxlite-app plan`' : '`boxlite-app plan`');
}

async function exportSpec(ctx: Ctx): Promise<void> {
  const spec = await (await ctx.appApi()).getSpec();
  if (ctx.json) ctx.out.data(spec);
  else ctx.out.raw(JSON.stringify(spec, null, 2));
}

async function clone(ctx: Ctx, appName: string, opts: { deployment?: string }): Promise<void> {
  const api = ctx.api().scoped(appName, ctx.envName);
  let number = opts.deployment !== undefined ? parseInteger(opts.deployment, '--deployment') : undefined;
  let specVersion: number | undefined;
  if (number === undefined) {
    const env = await api.getEnv();
    number = env.latest_deployment?.number ?? undefined;
    specVersion = env.spec_version ?? undefined;
    if (number === undefined) throw new MicrocloudError('not_found', `${appName}/${ctx.envName} has no deployment to clone`, 'start a new project instead: `boxlite-app init`');
  }
  const dest = resolve(ctx.cwd, appName);
  await mkdir(dest, { recursive: true });
  if ((await readdir(dest)).length > 0) throw new MicrocloudError('exists', `./${appName}/ already exists and is not empty`, `clone from another directory, or work in ./${appName}/ directly`);
  const source = await api.deploymentSource(number);
  await pipeline(Readable.from(source), tar.x({ cwd: dest }));
  if (specVersion === undefined) specVersion = (await api.getDeployment(number)).spec_version;
  await writeLink(dest, { app: appName, env: ctx.envName, base_version: specVersion ?? 0, api_url: api.baseUrl });
  ctx.out.data({ app: appName, env: ctx.envName, deployment: number, dir: dest });
  ctx.out.line(`cloned ${appName}/${ctx.envName} (deployment #${number}) into ./${appName}/`);
  ctx.out.next(`cd ${appName} && boxlite-app check`);
}

export function registerApp(program: Command, make: MakeCtx): Command {
  const app = program.command('app').description('inspect and operate the App (linked directory, BOXLITE_APP, or the key’s own App)');

  describe(app.command('status').description('environments, URLs and latest deployments').action(async (_o: unknown, cmd: Command) => status(await make(cmd))), {
    json: '{ name: string, created_at: string, url: string, envs: EnvSummary[] }',
    exits: [2, 3, 6],
    online: true,
  });
  describe(
    app
      .command('context')
      .description('everything about the environment: URLs, services, schema, migrations, volumes, sign-in, variables, deployments, errors, next actions')
      .option('--format <fmt>', 'markdown | json', 'markdown')
      .action(async (opts: { format?: string }, cmd: Command) => context(await make(cmd), opts)),
    { json: 'AgentContext (see shared/src/agent-context.ts)', exits: [2, 3, 6], online: true, examples: ['boxlite-app app context', 'boxlite-app app context --json | jq .next_actions'] },
  );
  registerDeployments(app, make);
  registerLogs(app, make);
  registerCurl(app, make);
  describe(app.command('services').description('service states, health, restarts').action(async (_o: unknown, cmd: Command) => services(await make(cmd))), {
    json: '{ name, state, restarts, last_exit_code, health, pid }[]',
    exits: [2, 3],
    online: true,
  });
  describe(
    app
      .command('restart [service]')
      .description('restart one service or all of them')
      .action(async (service: string | undefined, _o: unknown, cmd: Command) => restart(await make(cmd), service)),
    { json: '{ restarted: string[] }', exits: [2, 3, 4], online: true },
  );
  describe(
    app
      .command('access [action] [value]')
      .description('show or set who can reach the app: access | access set private|org|public | access clear (back to boxlite.toml)')
      .option('-y, --yes', 'required to set public')
      .action(async (action: string | undefined, value: string | undefined, _o: unknown, cmd: Command) => access(await make(cmd), action, value)),
    { json: '{ access: "private"|"org"|"public", source: "manifest"|"online" }', exits: [2, 3, 10], destructive: true, online: true, examples: ['boxlite-app app access', 'boxlite-app app access set public --yes'] },
  );
  describe(app.command('pull').description('rewrite boxlite.toml from the environment spec (old file kept as boxlite.toml.bak)').action(async (_o: unknown, cmd: Command) => pull(await make(cmd))), {
    json: '{ file: "boxlite.toml", version: number, backup: string | null }',
    exits: [2, 3, 4],
    online: true,
  });
  describe(app.command('export').description('print the environment spec as JSON').action(async (_o: unknown, cmd: Command) => exportSpec(await make(cmd))), {
    json: 'Spec (contracts §0)',
    exits: [2, 3, 4],
    online: true,
  });
  describe(
    app
      .command('clone <app>')
      .description('download the source of a deployment into ./<app>/ and link it')
      .option('--deployment <n>', 'deployment number (default: latest)')
      .action(async (name: string, opts: { deployment?: string }, cmd: Command) => clone(await make(cmd), name, opts)),
    { json: '{ app: string, env: string, deployment: number, dir: string }', exits: [2, 3, 4, 5], online: true },
  );

  registerEnv(app, make);
  registerSchedule(app, make);
  registerDb(app, make);
  registerVars(app, make);
  registerVolume(app, make);
  registerDev(app, make);
  return app;
}
