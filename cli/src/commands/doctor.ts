import { checkProject, contextFindings, MicrocloudError, rankFindings, type AgentContext, type Finding } from '@microcloud/shared';
import type { Command } from 'commander';
import type { Api } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { VERSION } from '../version.js';
import { diffMigrations } from './db.js';
import { whoamiData, type WhoAmIResult } from './whoami.js';

export interface Check {
  id: string;
  status: 'ok' | 'problem' | 'skipped';
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  app: string | null;
  env: string;
  cli: { version: string; latest_version: string | null };
  /** Worst first; each has a fix. */
  problems: Finding[];
  checks: Check[];
}

class Report {
  readonly problems: Finding[] = [];
  readonly checks: Check[] = [];

  ok(id: string, detail: string): void {
    this.checks.push({ id, status: 'ok', detail });
  }

  skip(id: string, detail: string): void {
    this.checks.push({ id, status: 'skipped', detail });
  }

  problem(id: string, f: Omit<Finding, 'id'> & { id?: string }): void {
    this.checks.push({ id, status: 'problem', detail: f.title });
    this.problems.push({ ...f, id: f.id ?? id });
  }
}

const describeError = (e: unknown): string => (e instanceof MicrocloudError ? `${e.code}: ${e.message}` : (e as Error).message);

/** link.json, boxlite.toml, lockfile and secret files: everything that needs no network. */
async function localChecks(ctx: Ctx, r: Report): Promise<Awaited<ReturnType<typeof checkProject>> | null> {
  if (!ctx.apiKey) r.problem('api_key', { severity: 'error', title: 'no App key: BOXLITE_API_KEY is not set and none is saved', fix: 'save the key from the App prompt once: `BOXLITE_API_URL=<url> BOXLITE_API_KEY=<key> boxlite-app login`' });
  if (!ctx.apiUrl) r.problem('api_url', { severity: 'error', title: 'BOXLITE_API_URL is not set and .boxlite/link.json has no api_url', fix: 'export BOXLITE_API_URL=https://<control plane> from the App prompt' });
  if (ctx.link) {
    if (ctx.env.BOXLITE_API_URL && ctx.link.api_url && ctx.link.api_url.replace(/\/+$/, '') !== ctx.env.BOXLITE_API_URL.replace(/\/+$/, '')) {
      r.problem('link', { severity: 'warn', title: `.boxlite/link.json points at ${ctx.link.api_url}, BOXLITE_API_URL at ${ctx.env.BOXLITE_API_URL}`, fix: 'BOXLITE_API_URL wins; if the link is stale, delete .boxlite/link.json and run `boxlite-app init`' });
    } else r.ok('link', `.boxlite/link.json → ${ctx.link.app}/${ctx.link.env}`);
  } else r.skip('link', 'not linked here (the key’s App is used); `boxlite-app init` links the directory');

  let checked: Awaited<ReturnType<typeof checkProject>> | null = null;
  try {
    checked = await checkProject(ctx.cwd, ctx.envName);
  } catch (e) {
    r.problem('manifest', { severity: 'error', title: `cannot read the project: ${describeError(e)}`, fix: 'run `boxlite-app check` for details' });
    return null;
  }
  const missing = checked.result.errors.find((e) => e.rule === 'missing_manifest');
  if (missing) r.skip('manifest', 'no boxlite.toml here');
  else if (!checked.result.ok) {
    const first = checked.result.errors[0]!;
    r.problem('manifest', {
      severity: 'error',
      title: `boxlite.toml has ${checked.result.errors.length} error(s); first: ${first.file}${first.line !== undefined ? `:${first.line}` : ''} ${first.message}`,
      fix: 'run `boxlite-app check` and fix every error it lists',
      evidence: checked.result.errors.slice(0, 5).map((e) => `${e.file}${e.line !== undefined ? `:${e.line}` : ''}  ${e.rule}  ${e.message}`),
    });
  } else r.ok('manifest', 'boxlite.toml is valid');

  const lock = checked.result.warnings.find((w) => w.rule === 'no_lockfile');
  if (lock) r.problem('lockfile', { severity: 'warn', title: lock.message, fix: 'run `npm install` (or your package manager) and keep the lockfile in the project; `npm ci` in the cloud build fails without it' });
  else if (checked.manifest) r.ok('lockfile', 'lockfile present');
  for (const w of checked.result.warnings.filter((x) => x.rule === 'secret_file' && !x.message.endsWith('(excluded)'))) {
    r.problem('secret_file', { severity: 'warn', title: w.message, fix: 'add the file to .boxliteignore, and rotate the secret if it was ever deployed' });
  }
  return checked;
}

async function migrationChecks(api: Api, checked: Awaited<ReturnType<typeof checkProject>> | null, c: AgentContext, r: Report): Promise<boolean> {
  if (!checked?.manifest?.database || !checked.migrations.length || c.database?.status !== 'ready') return false;
  let applied;
  try {
    applied = await api.dbApplied();
  } catch (e) {
    r.skip('migrations', `could not read applied migrations: ${describeError(e)}`);
    return false;
  }
  const dir = checked.manifest.database.migrations;
  const diff = diffMigrations(checked.migrations, applied);
  const changed = diff.filter((m) => m.status === 'changed');
  const pending = diff.filter((m) => m.status === 'pending');
  for (const m of changed) r.problem('migrations', { id: 'migration_changed', severity: 'error', title: `${dir}${m.file} was edited after it was applied in #${m.deployment ?? '?'}`, fix: `restore ${dir}${m.file} and put the change in a new file: \`boxlite-app app db migration new <name>\`` });
  if (pending.length) r.problem('migrations', { id: 'pending_migrations', severity: 'warn', title: `${pending.length} local migration(s) not applied: ${pending.map((m) => m.file).join(', ')}`, fix: '`boxlite-app apply --yes` (or `boxlite-app deploy`) runs them' });
  if (!changed.length && !pending.length) r.ok('migrations', `${diff.length} migration(s) applied, none pending`);
  return true;
}

async function reachability(api: Api, c: AgentContext, r: Report): Promise<void> {
  if (!c.live) {
    r.skip('reachable', 'nothing is live yet');
    return;
  }
  try {
    const p = await api.probe();
    if (p.ok) r.ok('reachable', `GET ${p.path} → ${p.status} in ${p.ms} ms`);
    else if (p.starting) r.problem('reachable', { severity: 'info', title: 'the app was asleep and is starting', fix: 'rerun `boxlite-app doctor` in 20 s' });
    else
      r.problem('reachable', {
        severity: 'error',
        title: `GET ${p.url} → ${p.status ?? 'no answer'} (${p.reason})`,
        fix: p.status === 404 ? `add a route for ${p.path}, or set health on the exposed [[service]] to a path that returns 200` : '`boxlite-app app logs --level error --since 15m` shows what the app printed; fix it and `boxlite-app deploy`',
        evidence: p.body_head ? [p.body_head.slice(0, 200)] : undefined,
      });
  } catch (e) {
    r.skip('reachable', `probe failed: ${describeError(e)}`);
  }
}

/** Runs every local and online check; never throws for a failed check, only reports it. */
export async function runDoctor(ctx: Ctx): Promise<DoctorReport> {
  const r = new Report();
  const checked = await localChecks(ctx, r);
  let who: WhoAmIResult | null = null;
  let latest: string | null = null;

  if (ctx.apiKey && ctx.apiUrl) {
    try {
      who = await whoamiData(ctx);
      latest = who.cli.latest_version;
      r.ok('key', `key …${who.key?.last4 ?? '?'} belongs to ${who.app}`);
      if (who.linked.matches_key === false) r.problem('link', { severity: 'error', title: `.boxlite/link.json is linked to "${who.linked.app}", but the key belongs to "${who.app}"`, fix: `use the key of ${who.linked.app}, or delete .boxlite/link.json and run \`boxlite-app init\`` });
    } catch (e) {
      const code = e instanceof MicrocloudError ? e.code : 'internal';
      r.problem('key', {
        severity: 'error',
        title: code === 'unauthenticated' ? 'the control plane does not accept BOXLITE_API_KEY' : `cannot reach the control plane: ${describeError(e)}`,
        fix: code === 'unauthenticated' ? 'save a working key: `BOXLITE_API_URL=<url> BOXLITE_API_KEY=<key> boxlite-app login` with the key from the App prompt (Copy prompt in the console issues a new one)' : (e instanceof MicrocloudError && e.next) || 'check BOXLITE_API_URL',
      });
    }
  }

  if (who) {
    if (who.cli.update_available) r.problem('cli_version', { severity: 'warn', title: `CLI ${VERSION} is older than ${who.cli.latest_version}`, fix: `\`${who.cli.update_command}\`` });
    else r.ok('cli_version', `CLI ${VERSION}${latest ? ` (latest ${latest})` : ''}`);
    const api = await ctx.appApi();
    let c: AgentContext | null = null;
    try {
      c = await api.envContext();
    } catch (e) {
      r.problem('environment', { severity: 'error', title: `cannot read ${who.app}/${ctx.envName}: ${describeError(e)}`, fix: e instanceof MicrocloudError && e.next ? e.next : '`boxlite-app app status`' });
    }
    if (c) {
      const localMigrations = await migrationChecks(api, checked, c, r);
      // The control plane only knows the migrations of its last deployment; the local diff is fresher.
      const online = (c.next_actions.length ? c.next_actions : contextFindings(c)).filter((f) => !(localMigrations && (f.id === 'pending_migrations' || f.id === 'migration_changed')));
      for (const f of online) r.problem(f.id, f);
      if (!online.some((f) => f.id === 'deploy_failed')) r.ok('last_deployment', c.deployments[0] ? `#${c.deployments[0].number} ${c.deployments[0].status}` : 'no deployments');
      if (!online.some((f) => f.id === 'crash_loop' || f.id === 'service_down')) r.ok('services', c.services.length ? c.services.map((s) => `${s.name} ${s.state ?? 'not started'}`).join(', ') : 'none yet');
      if (c.database && c.database.status === 'ready') r.ok('database', `ready${c.database.branch ? ` (branch ${c.database.branch})` : ''}`);
      if (c.auth.enabled && !online.some((f) => f.id.startsWith('auth_'))) r.ok('auth', `providers ready: ${c.auth.providers.map((p) => p.name).join(', ')}`);
      r.ok('access', `access ${c.access.level}${c.access.source === 'online' ? ' (online override)' : ''}`);
      await reachability(api, c, r);
    }
  } else if (ctx.apiKey && ctx.apiUrl) r.skip('online', 'online checks skipped: the control plane did not accept the key');
  else r.skip('online', 'online checks skipped: BOXLITE_API_KEY / BOXLITE_API_URL missing');

  const problems = rankFindings(r.problems);
  return { ok: !problems.some((p) => p.severity === 'error'), app: who?.app ?? ctx.app ?? null, env: ctx.envName, cli: { version: VERSION, latest_version: latest }, problems, checks: r.checks };
}

const MARK: Record<string, string> = { error: 'x', warn: '!', info: 'i' };

async function doctor(ctx: Ctx): Promise<void> {
  const report = await runDoctor(ctx);
  ctx.out.data(report);
  ctx.out.line(`Doctor · ${report.app ?? '(no app)'}/${report.env} · CLI ${report.cli.version}`);
  ctx.out.line('');
  if (!report.problems.length) ctx.out.line('No problems found.');
  for (const p of report.problems) {
    ctx.out.line(`${MARK[p.severity]} ${p.severity.padEnd(5)} ${p.title}${p.detail ? ` (${p.detail})` : ''}`);
    ctx.out.line(`        fix: ${p.fix}`);
    for (const e of p.evidence ?? []) ctx.out.line(`        | ${e.slice(0, 240)}`);
  }
  const passed = report.checks.filter((c) => c.status === 'ok');
  if (passed.length) {
    ctx.out.line('');
    ctx.out.line(`Passed: ${passed.map((c) => `${c.id} (${c.detail})`).join('; ')}`);
  }
  const first = report.problems[0];
  if (first) ctx.out.next(first.fix);
}

export function registerDoctor(program: Command, make: MakeCtx): void {
  describe(program.command('doctor').description('run every local and online check and list the problems, worst first, each with a fix').action(async (_o: unknown, cmd: Command) => doctor(await make(cmd))), {
    json: '{ ok: boolean (no error-severity problems), app, env, cli: { version, latest_version }, problems: { id, severity: "error"|"warn"|"info", title, fix, detail?, evidence? }[], checks: { id, status: "ok"|"problem"|"skipped", detail }[] }',
    exits: [],
    online: true,
    examples: ['boxlite-app doctor', 'boxlite-app doctor --json | jq ".problems[0].fix"'],
  });
}
