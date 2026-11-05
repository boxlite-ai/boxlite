/** The App handoff prompt with its organization API URL and project selection. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ctx } from './ctx'

const FALLBACK_TEMPLATE = `You are building an app on BoxLite Cloud. First read {{AGENT_URL}} and follow it exactly.

BOXLITE_API_URL={{API_URL}}
BOXLITE_CLI_URL={{CLI_URL}}
App: {{APP}}
Environment: {{ENV}}

Use an organization API key from Dashboard > API Keys with boxlite-app login.
Then run boxlite-app init --app {{APP}} --env {{ENV}} in the project directory.

What I want: {{REQUEST}}
`

function promptTemplate(ctx: Pick<Ctx, 'config'>): string {
  const path = ctx.config.promptTemplatePath ?? join(dirname(ctx.config.agentMdPath), 'prompt-template.md')
  return existsSync(path) ? readFileSync(path, 'utf8') : FALLBACK_TEMPLATE
}

export function handoffPrompt(ctx: Pick<Ctx, 'config'>, app: string, env = 'main'): string {
  return (
    promptTemplate(ctx)
      .replaceAll('{{API_URL}}', ctx.config.managementUrl)
      .replaceAll('{{AGENT_URL}}', ctx.config.artifactUrl + '/agent.md')
      .replaceAll('{{CLI_URL}}', ctx.config.artifactUrl + '/boxlite-app.tgz')
      .replaceAll('{{APP}}', app)
      .replaceAll('{{ENV}}', env)
      .replace(/^.*\{\{REQUEST\}\}.*$/m, 'What I want: (tell your agent here)')
      .trimEnd() + '\n'
  )
}
