import type { Command } from 'commander'
import type { CliVersion, EnvSummary } from '../api.js'
import type { MakeCtx } from '../cli.js'
import type { Ctx } from '../context.js'
import { describe } from '../meta.js'
import { compareVersions, VERSION } from '../version.js'

export interface WhoAmIResult {
  organization_id: string
  app: string | null
  env: string
  actor: string
  key: { last4: string }
  scope: 'organization'
  control_plane: string
  api_url: string
  environments: EnvSummary[]
  sign_in_providers: string[] | null
  linked: { link_file: boolean; app: string | null }
  cli: { version: string; latest_version: string | null; update_available: boolean; update_command: string | null }
}

function cliInfo(latest: CliVersion | null): WhoAmIResult['cli'] {
  const update = latest !== null && compareVersions(latest.version, VERSION) > 0
  return {
    version: VERSION,
    latest_version: latest?.version ?? null,
    update_available: update,
    update_command: update ? `npm install -g ${latest.url}` : null,
  }
}

/** Organization identity, the local App selection and CLI version. */
export async function whoamiData(ctx: Ctx): Promise<WhoAmIResult> {
  const api = ctx.api()
  const me = await api.whoami()
  const [app, latest] = await Promise.all([ctx.app ? api.getApp() : null, api.cliVersion().catch(() => null)])
  return {
    organization_id: me.organization_id,
    app: app?.name ?? null,
    env: ctx.envName,
    actor: me.actor,
    key: { last4: me.key_last4 },
    scope: 'organization',
    control_plane: api.baseUrl,
    api_url: api.baseUrl,
    environments: app?.envs ?? [],
    sign_in_providers: app?.sign_in_providers ?? null,
    linked: {
      link_file: ctx.link !== null,
      app: ctx.link?.app ?? null,
    },
    cli: cliInfo(latest),
  }
}

async function whoami(ctx: Ctx): Promise<void> {
  const w = await whoamiData(ctx)
  ctx.out.data(w)
  ctx.out.line(`Organization ${w.organization_id} · key …${w.key.last4}`)
  ctx.out.line(`Control plane ${w.api_url}`)
  if (w.app) {
    ctx.out.line(`App ${w.app} · environment ${w.env}`)
    ctx.out.line(
      `Environments ${w.environments.map((e) => `${e.name} ${e.status ?? ''}`.trim()).join(' · ') || '(none)'}`,
    )
  }
  if (w.sign_in_providers)
    ctx.out.line(
      `Sign-in that works here ${w.sign_in_providers.join(', ') || '(none yet: the owner adds one in the console)'}`,
    )
  ctx.out.line(`CLI ${w.cli.version}${w.cli.latest_version ? ` (latest ${w.cli.latest_version})` : ''}`)
  if (w.cli.update_available) ctx.out.next(`update the CLI: \`${w.cli.update_command}\``)
  else if (w.linked.link_file) ctx.out.next('`boxlite-app app context`')
  else ctx.out.next(`link this directory with \`boxlite-app init --app ${w.app ?? '<name>'}\``)
}

export function registerWhoami(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('whoami')
      .description('the organization, selected App and environment, and whether a newer CLI exists')
      .action(async (_o: unknown, cmd: Command) => whoami(await make(cmd))),
    {
      json: '{ organization_id, app: string | null, env, actor, key: { last4 }, scope, control_plane, api_url, environments: { name, status, url }[], sign_in_providers, linked: { link_file, app }, cli: { version, latest_version, update_available, update_command } }',
      exits: [2, 3, 5, 6],
      online: true,
    },
  )
}
