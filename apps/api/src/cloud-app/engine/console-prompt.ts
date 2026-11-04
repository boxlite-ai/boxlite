/** The App hand-off prompt (agent/prompt-template.md filled in) and the masked App key the console shows. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppRow } from './db'
import type { Ctx } from './ctx'

const FALLBACK_TEMPLATE = `You are building an app on BoxLite Cloud. First read {{AGENT_URL}} and follow it exactly.

BOXLITE_API_URL={{API_URL}}
BOXLITE_CLI_URL={{CLI_URL}}
BOXLITE_API_KEY={{APP_KEY}}
App: {{APP}}

What I want: {{REQUEST}}
`

function promptTemplate(ctx: Pick<Ctx, 'config'>): string {
  const path = ctx.config.promptTemplatePath ?? join(dirname(ctx.config.agentMdPath), 'prompt-template.md')
  return existsSync(path) ? readFileSync(path, 'utf8') : FALLBACK_TEMPLATE
}

/** agent/prompt-template.md filled in. Without a request the "What I want" line is left for the user to finish in their agent. */
/**
 * The prompt a person pastes into their agent. `env` other than main is named in it: the agent works
 * there (every command with --env), not on main.
 */
export function handoffPrompt(
  ctx: Pick<Ctx, 'config'>,
  app: string,
  key: string,
  request?: string,
  env = 'main',
): string {
  let text = promptTemplate(ctx)
    .replaceAll('{{API_URL}}', ctx.config.managementUrl)
    .replaceAll('{{AGENT_URL}}', ctx.config.artifactUrl + '/agent.md')
    .replaceAll('{{CLI_URL}}', ctx.config.artifactUrl + '/boxlite-app.tgz')
    .replaceAll('{{APP_KEY}}', key)
    .replaceAll('{{APP}}', app)
  if (env !== 'main')
    text = text.replace(
      /^(App: .*)$/m,
      `$1\nEnvironment: ${env} (run every boxlite-app command with --env ${env}; leave main alone)`,
    )
  if (request?.trim()) text = text.replaceAll('{{REQUEST}}', request.trim())
  else text = text.replace(/^.*\{\{REQUEST\}\}.*$/m, 'What I want: (tell your agent here)')
  return text.trimEnd() + '\n'
}

export const maskKey = (last4: string) => `••••••••••••${last4}`

export async function currentKey(
  ctx: Pick<Ctx, 'credentials'>,
  app: AppRow,
): Promise<{ last4: string; createdAt: string } | null> {
  const row = (await ctx.credentials.list(app))[0]
  return row ? { last4: row.last4, createdAt: row.created_at } : null
}
