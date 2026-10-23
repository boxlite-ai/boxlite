import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import { Api } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { forgetKey, saveKey } from '../credentials.js';
import { describe } from '../meta.js';
import { readStdin } from './common.js';

/**
 * Saves the App key once (credentials.ts), so later shells need no BOXLITE_API_KEY and the raw key
 * stops showing up in command text. The key comes from BOXLITE_API_KEY or, with --stdin, from a
 * pipe; never from an argument. It is checked with the control plane before it is saved.
 */
async function login(ctx: Ctx, opts: { stdin?: boolean }): Promise<void> {
  const key = (opts.stdin ? (await readStdin(ctx)).trim() : ctx.env.BOXLITE_API_KEY) || '';
  if (!key) {
    throw new MicrocloudError('usage', 'no key to save: set BOXLITE_API_KEY, or pipe it in with --stdin', 'from the App prompt: `BOXLITE_API_URL=<url> BOXLITE_API_KEY=<key> boxlite-app login`');
  }
  const url = ctx.env.BOXLITE_API_URL || ctx.link?.api_url;
  if (!url) throw new MicrocloudError('missing_api_url', 'BOXLITE_API_URL is not set', 'set it to the URL in the App prompt and rerun `boxlite-app login`');
  const me = await new Api({ baseUrl: url, key, env: ctx.envName, dispatcher: ctx.dispatcher }).whoami();
  const path = saveKey(ctx.env, { api_url: url, app: me.app, key });
  ctx.out.data({ app: me.app, api_url: url.replace(/\/+$/, ''), key_last4: key.slice(-4), saved_to: path });
  ctx.out.line(`saved the key …${key.slice(-4)} for ${me.app} on ${url.replace(/\/+$/, '')} (${path}, readable by you only)`);
  ctx.out.next('later commands in any shell use it: no need to export BOXLITE_API_KEY again; `boxlite-app whoami` checks');
}

async function logout(ctx: Ctx, opts: { all?: boolean }): Promise<void> {
  const removed = forgetKey(ctx.env, opts.all ? undefined : ctx.apiUrl, opts.all ? undefined : ctx.app);
  ctx.out.data({ removed });
  ctx.out.line(removed ? 'forgot the saved key' : 'no saved key to forget');
}

export function registerLogin(program: Command, make: MakeCtx): void {
  describe(
    program
      .command('login')
      .description('save the App key once so later shells need no BOXLITE_API_KEY: from BOXLITE_API_KEY, or a pipe with --stdin (never an argument)')
      .option('--stdin', 'read the key from stdin')
      .action(async (opts: { stdin?: boolean }, cmd: Command) => login(await make(cmd), opts)),
    {
      json: '{ app, api_url, key_last4, saved_to }',
      exits: [2, 3, 6],
      online: true,
      examples: ['BOXLITE_API_URL=https://cp.example BOXLITE_API_KEY=bxl_app_… boxlite-app login'],
    },
  );
  describe(
    program
      .command('logout')
      .description('forget the saved key of this App (--all: every saved key)')
      .option('--all', 'forget every saved key')
      .action(async (opts: { all?: boolean }, cmd: Command) => logout(await make(cmd), opts)),
    { json: '{ removed: boolean }', exits: [], online: false },
  );
}
