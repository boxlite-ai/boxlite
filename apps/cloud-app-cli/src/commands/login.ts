import { MicrocloudError } from '@boxlite-ai/cloud-app-shared'
import type { Command } from 'commander'
import { Api } from '../api.js'
import type { MakeCtx } from '../cli.js'
import type { Ctx } from '../context.js'
import { forgetKey, saveKey } from '../credentials.js'
import { describe } from '../meta.js'
import { readStdin } from './common.js'

/**
 * Saves the organization key once, so later shells need no BOXLITE_API_KEY and the raw key
 * stops showing up in command text. The key comes from BOXLITE_API_KEY or, with --stdin, from a
 * pipe; never from an argument. It is checked with the control plane before it is saved.
 */
async function login(ctx: Ctx, opts: { stdin?: boolean }): Promise<void> {
  const key = (opts.stdin ? (await readStdin(ctx)).trim() : ctx.env.BOXLITE_API_KEY) || ''
  if (!key) {
    throw new MicrocloudError(
      'usage',
      'no key to save: set BOXLITE_API_KEY, or pipe it in with --stdin',
      'save your organization API key with `BOXLITE_API_URL=<url> BOXLITE_API_KEY=<key> boxlite-app login`',
    )
  }
  const url = ctx.apiUrl
  if (!url)
    throw new MicrocloudError(
      'missing_api_url',
      'BOXLITE_API_URL is not set',
      'set it to the URL in the App prompt and rerun `boxlite-app login`',
    )
  const api = new Api({ baseUrl: url, key, dispatcher: ctx.dispatcher })
  const me = await api.whoami()
  const path = saveKey(ctx.env, { api_url: api.baseUrl, key })
  ctx.out.data({ organization_id: me.organization_id, api_url: api.baseUrl, key_last4: me.key_last4, saved_to: path })
  ctx.out.line(
    `saved the key …${me.key_last4} for organization ${me.organization_id} on ${api.baseUrl} (${path}, readable by you only)`,
  )
  ctx.out.next('in the project folder, run `boxlite-app init --app <name>` with the App name from the prompt')
}

async function logout(ctx: Ctx, opts: { all?: boolean }): Promise<void> {
  const url = opts.all ? undefined : ctx.apiUrl
  if (!opts.all && !url)
    throw new MicrocloudError(
      'usage',
      'no organization API URL is selected',
      'run it in the linked project, set BOXLITE_API_URL, or pass --all',
    )
  const removed = forgetKey(ctx.env, url)
  ctx.out.data({ removed })
  ctx.out.line(removed ? 'forgot the saved key' : 'no saved key to forget')
}

export function registerLogin(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('login')
      .description('save the organization API key from BOXLITE_API_KEY or a pipe with --stdin')
      .option('--stdin', 'read the key from stdin')
      .action(async (opts: { stdin?: boolean }, cmd: Command) => login(await make(cmd), opts)),
    {
      json: '{ organization_id, api_url, key_last4, saved_to }',
      exits: [2, 5, 6],
      online: true,
      examples: [
        'BOXLITE_API_URL=https://api.example.test/api/v1/<organization-id> BOXLITE_API_KEY=<organization-key> boxlite-app login',
      ],
    },
  )
  describe(
    program
      .command('logout')
      .description('forget the selected organization API key (--all: every saved key)')
      .option('--all', 'forget every saved key')
      .action(async (opts: { all?: boolean }, cmd: Command) => logout(await make(cmd), opts)),
    { json: '{ removed: boolean }', exits: [], online: false },
  )
}
