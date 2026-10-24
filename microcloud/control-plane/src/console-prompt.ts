/** The App hand-off prompt (agent/prompt-template.md filled in) and the masked App key the console shows. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppRow } from './db.js';
import type { Ctx } from './ctx.js';

const FALLBACK_TEMPLATE = `You are building an app on BoxLite Cloud. First read {{CP_URL}}/agent.md and follow it exactly.

BOXLITE_API_URL={{CP_URL}}
BOXLITE_API_KEY={{APP_KEY}}
App: {{APP}}

What I want: {{REQUEST}}
`;

function promptTemplate(ctx: Pick<Ctx, 'config'>): string {
  const path = ctx.config.promptTemplatePath ?? join(dirname(ctx.config.agentMdPath), 'prompt-template.md');
  return existsSync(path) ? readFileSync(path, 'utf8') : FALLBACK_TEMPLATE;
}

/** agent/prompt-template.md filled in. Without a request the "What I want" line is left for the user to finish in their agent. */
/**
 * The prompt a person pastes into their agent. `env` other than main is named in it: the agent works
 * there (every command with --env), not on main.
 */
export function handoffPrompt(ctx: Pick<Ctx, 'config'>, app: string, key: string, request?: string, env = 'main'): string {
  let text = promptTemplate(ctx).replaceAll('{{CP_URL}}', ctx.config.publicUrl).replaceAll('{{APP_KEY}}', key).replaceAll('{{APP}}', app);
  if (env !== 'main') text = text.replace(/^(App: .*)$/m, `$1\nEnvironment: ${env} (run every boxlite-app command with --env ${env}; leave main alone)`);
  if (request?.trim()) text = text.replaceAll('{{REQUEST}}', request.trim());
  else text = text.replace(/^.*\{\{REQUEST\}\}.*$/m, 'What I want: (tell your agent here)');
  return text.trimEnd() + '\n';
}

export const maskKey = (last4: string) => `bxl_app_••••••••••••${last4}`;

export function currentKey(ctx: Pick<Ctx, 'store'>, app: AppRow): { last4: string; createdAt: string } | null {
  const row = ctx.store.get<{ last4: string; created_at: string }>('SELECT last4, created_at FROM keys WHERE app_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1', app.id);
  return row ? { last4: row.last4, createdAt: row.created_at } : null;
}
