import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import type { WhoAmI } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { compareVersions, VERSION } from '../version.js';

export interface WhoAmIResult {
  app: string;
  env: string;
  actor: string;
  key: { last4: string; created_at: string } | null;
  scope: string;
  control_plane: string;
  api_url: string;
  environments: WhoAmI['environments'];
  /** Sign-in providers that work for this App now (null from an older control plane). */
  sign_in_providers: string[] | null;
  linked: { link_file: boolean; app: string | null; matches_key: boolean | null };
  cli: { version: string; latest_version: string | null; update_available: boolean; update_command: string | null };
}

export function cliInfo(apiUrl: string, latest: string | null): WhoAmIResult['cli'] {
  const update = latest !== null && compareVersions(latest, VERSION) > 0;
  return { version: VERSION, latest_version: latest, update_available: update, update_command: update ? `npm install -g ${apiUrl.replace(/\/+$/, '')}/cli/boxlite-app.tgz` : null };
}

/** Who the key is, which App and environment commands here will act on, and whether the CLI is current. */
export async function whoamiData(ctx: Ctx): Promise<WhoAmIResult> {
  const api = ctx.api();
  let me: WhoAmI;
  try {
    me = await api.whoami();
  } catch (e) {
    // A control plane without /whoami still resolves the key's App.
    if (!(e instanceof MicrocloudError && (e.code === 'not_found' || e.code === 'http_404'))) throw e;
    const info = await api.getApp('me');
    me = { app: info.name, actor: 'key', key: null, scope: `app:${info.name}`, environments: (info.envs ?? []).map((x) => ({ name: x.name, status: x.status ?? '', url: x.url ?? '' })), control_plane: api.baseUrl, cli: { latest_version: null, download_url: `${api.baseUrl}/cli/boxlite-app.tgz` } };
  }
  const latest = me.cli?.latest_version ?? (await api.cliVersion().catch(() => null))?.version ?? null;
  return {
    app: me.app,
    env: ctx.envName,
    actor: me.actor,
    key: me.key,
    scope: me.scope,
    control_plane: me.control_plane,
    api_url: api.baseUrl,
    environments: me.environments,
    sign_in_providers: me.sign_in_providers ?? null,
    linked: { link_file: ctx.link !== null, app: ctx.link?.app ?? null, matches_key: ctx.link ? ctx.link.app === me.app : null },
    cli: cliInfo(api.baseUrl, latest),
  };
}

async function whoami(ctx: Ctx): Promise<void> {
  const w = await whoamiData(ctx);
  ctx.out.data(w);
  ctx.out.line(`App ${w.app} · environment ${w.env} · key ${w.key ? `…${w.key.last4}` : w.actor} (scope: ${w.scope === `app:${w.app}` ? 'this App only' : w.scope})`);
  ctx.out.line(`Control plane ${w.control_plane}${w.control_plane !== w.api_url ? ` (via ${w.api_url})` : ''}`);
  ctx.out.line(`Environments ${w.environments.map((e) => `${e.name} ${e.status}`).join(' · ') || '(none)'}`);
  if (w.sign_in_providers) ctx.out.line(`Sign-in that works here ${w.sign_in_providers.join(', ') || '(none yet: the owner adds one in the console)'}`);
  ctx.out.line(`CLI ${w.cli.version}${w.cli.latest_version ? ` (latest ${w.cli.latest_version})` : ''}`);
  if (w.linked.matches_key === false) {
    ctx.out.line(`warning: .boxlite/link.json is linked to "${w.linked.app}", but this key belongs to "${w.app}"`);
    ctx.out.next(`use the key of ${w.linked.app}, or relink: delete .boxlite/link.json and run \`boxlite-app init\``);
  } else if (w.cli.update_available) ctx.out.next(`update the CLI: \`${w.cli.update_command}\``);
  else ctx.out.next(w.linked.link_file ? '`boxlite-app app context`' : '`boxlite-app init` links this directory; or `boxlite-app app context`');
}

export function registerWhoami(program: Command, make: MakeCtx): void {
  describe(program.command('whoami').description('the key’s App and scope, the environment, the control plane, and whether a newer CLI exists').action(async (_o: unknown, cmd: Command) => whoami(await make(cmd))), {
    json: '{ app, env, actor, key: { last4, created_at } | null, scope, control_plane, api_url, environments: { name, status, url }[], linked: { link_file, app, matches_key }, cli: { version, latest_version, update_available, update_command } }',
    exits: [2, 6],
    online: true,
  });
}
