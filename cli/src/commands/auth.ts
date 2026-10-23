import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import type { AuthUser } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { roleOption } from './curl.js';
import { formatAgo, table } from '../output.js';

async function status(ctx: Ctx): Promise<void> {
  const s = await (await ctx.appApi()).authStatus();
  ctx.out.data(s);
  if (!s.enabled) {
    ctx.out.line('sign-in off (no [auth] in boxlite.toml)');
    ctx.out.next('add [auth] with the providers `boxlite-app whoami` lists as working, e.g. providers = ["github"], then `boxlite-app apply --yes`');
    return;
  }
  ctx.out.line(`sign-in on · ${s.providers.map((p) => `${p.name} ${p.status === 'ready' ? 'ready' : 'not configured on this platform yet'}`).join(' · ')}`);
  ctx.out.line(`  protect  ${s.protect.length ? s.protect.join(' ') : '(none: pages decide themselves)'}`);
  ctx.out.line(`  login    ${s.login_url}`);
  ctx.out.line(`  users    ${s.users}`);
  ctx.out.next('`boxlite-app app auth test-session --email qa@example.com` signs in a test user for curl checks');
}

async function redirectUris(ctx: Ctx): Promise<void> {
  const list = await (await ctx.appApi()).authRedirectUris();
  ctx.out.data(list);
  for (const line of table(list.map((u) => [u.provider, u.redirect_uri, u.status === 'ready' ? 'ready' : 'not configured']))) ctx.out.line(line);
  ctx.out.line('The platform owns these OAuth apps; there is nothing to register.');
}

function userRows(users: AuthUser[]): string[] {
  return table(users.map((u) => [u.email ?? '(no email)', u.name ?? '', u.provider, u.blocked ? 'blocked' : '', u.last_seen ? `seen ${formatAgo(u.last_seen)}` : '']));
}

/** `<email>` → every user with that email (one per provider); anything else is taken as a user id. */
async function resolveUsers(ctx: Ctx, target: string): Promise<{ id: string; label: string }[]> {
  if (!target.includes('@')) return [{ id: target, label: target }];
  const found = (await (await ctx.appApi()).authUsers(target)).filter((u) => u.email?.toLowerCase() === target.toLowerCase());
  if (!found.length) throw new MicrocloudError('not_found', `no user with email ${target} in ${ctx.envName}`, '`boxlite-app app auth users` lists them');
  return found.map((u) => ({ id: u.id, label: `${u.email} (${u.provider})` }));
}

async function users(ctx: Ctx, action: string | undefined, target: string | undefined, opts: { search?: string }): Promise<void> {
  const api = await ctx.appApi();
  if (action === undefined) {
    const list = await api.authUsers(opts.search);
    ctx.out.data(list);
    if (!list.length) ctx.out.line(opts.search ? `no users match "${opts.search}"` : 'no users yet');
    for (const line of userRows(list)) ctx.out.line(line);
    return;
  }
  if (action === 'export') {
    if (ctx.json) ctx.out.data(await api.authUsers());
    else ctx.out.raw(await api.authUsersCsv());
    return;
  }
  if (action === 'purge-test') {
    if (!(await ctx.confirmDestructive({ action: `remove every test user of ${ctx.envName}`, destroys: ['the users test sessions created (`--as`), their sessions, and their rows in boxlite.users', 'never a user who signed in for real'], undo: 'none: a later `--as` makes the user again' }))) return;
    const r = await api.purgeTestUsers();
    ctx.out.data(r);
    ctx.out.line(`removed ${r.removed} test user${r.removed === 1 ? '' : 's'}${r.emails.length ? `: ${r.emails.join(', ')}` : ''}`);
    if (r.mirror.startsWith('kept')) ctx.out.line(`boxlite.users rows ${r.mirror}`);
    ctx.out.next(r.mirror.startsWith('kept') ? "delete the app's own rows that point at them first (`boxlite-app app sql --write`), then rerun; or test in a separate environment next time" : 'the rows your app wrote for them are its own data: delete those with `boxlite-app app sql --write`, or test in a separate environment (`boxlite-app app env create qa`) and delete it afterwards');
    return;
  }
  if (action !== 'signout' && action !== 'block' && action !== 'unblock') {
    throw new MicrocloudError('usage', `unknown action "${action}"`, '`boxlite-app app auth users`, `users signout|block|unblock <email>`, `users purge-test`, `users export`, or `users --search <text>`');
  }
  if (!target) throw new MicrocloudError('usage', `${action} needs an email or user id`, `\`boxlite-app app auth users ${action} <email>\``);
  const done: AuthUser[] = [];
  for (const u of await resolveUsers(ctx, target)) {
    const r = await api.authUserAction(u.id, action);
    done.push(r);
    const what = action === 'signout' ? `signed out (${r.revoked ?? 0} session${r.revoked === 1 ? '' : 's'})` : action === 'block' ? 'blocked, sessions revoked' : 'unblocked';
    ctx.out.line(`${u.label}: ${what}`);
  }
  ctx.out.data(done);
}

async function testSession(ctx: Ctx, opts: { email: string; role?: string }): Promise<void> {
  const s = await (await ctx.appApi()).createTestSession(opts.email, roleOption(opts.role));
  ctx.out.data(s);
  ctx.out.line(`test user ${s.user?.email ?? opts.email}${s.role === 'owner' ? ' (owner)' : ''} · expires in ${s.expires_in}`);
  ctx.out.line(`cookie: ${s.cookie}`);
  ctx.out.next(`curl -H 'Cookie: ${s.cookie}' "<app url>/<protected path>"`);
}

export function registerAuth(app: Command, make: MakeCtx): void {
  const auth = app.command('auth').description('end-user sign-in: status, users, test sessions');
  describe(auth.command('status').description('providers, protected paths, login URL and user count').action(async (_o: unknown, cmd: Command) => status(await make(cmd))), {
    json: '{ enabled, providers: { name, status: "ready" | "not_configured" }[], protect: string[], login_url, users }',
    exits: [2, 3],
    online: true,
  });
  describe(auth.command('redirect-uris').description('OAuth callback URLs the platform uses').action(async (_o: unknown, cmd: Command) => redirectUris(await make(cmd))), {
    json: '{ provider, redirect_uri, status }[]',
    exits: [2, 3],
    online: true,
  });
  describe(
    auth
      .command('users [action] [email]')
      .description('list users; or: users signout|block|unblock <email>, users purge-test (remove the test users --as made), users export (CSV)')
      .option('--search <text>', 'filter by email or name')
      .option('-y, --yes', 'skip the confirmation (purge-test)')
      .action(async (action: string | undefined, email: string | undefined, opts: { search?: string }, cmd: Command) => users(await make(cmd), action, email, opts)),
    { json: 'AuthUser[] ({ id, email, name, provider, first_seen, last_seen, blocked, active_sessions })', exits: [2, 3, 4], online: true },
  );
  describe(
    auth
      .command('test-session')
      .description('sign in a test user for 15 minutes and print its cookie (for curl checks)')
      .requiredOption('--email <email>', 'test user email, e.g. qa@example.com')
      .option('--role <role>', 'owner (manages the App in the console) or user (default); sent as X-BoxLite-User-Role')
      .action(async (opts: { email: string; role?: string }, cmd: Command) => testSession(await make(cmd), opts)),
    { json: '{ cookie, cookie_name, expires_in: "15m", expires_at, role: "owner" | "user", user }', exits: [2, 3], online: true },
  );
}
