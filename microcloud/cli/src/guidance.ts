import { MicrocloudError } from '@microcloud/shared';

/**
 * Makes every error actionable: a `next` that is a runnable command or a file edit (never "try
 * again"), and a `docs` pointer to the offline guide. Control-plane messages and their `next` are
 * passed through unchanged unless the `next` is missing or generic. Hints are fixed where they are
 * written, never rewritten here: `test/hints.test.ts` parses every boxlite-app command they name.
 */

export interface ErrorContext {
  /** Command path, e.g. `app deployment`. */
  command: string;
  /** The exact command line, for "rerun" hints. */
  commandLine: string;
  env: string;
  /** The error was raised in this process (a CLI bug), not answered by the control plane. */
  clientSide?: boolean;
}

const GENERIC_NEXT = /^(retry|try again)( in a (moment|minute))?\.?$/i;

const DOCS: Record<string, string> = {
  unauthenticated: 'boxlite-app docs setup',
  not_linked: 'boxlite-app docs setup',
  missing_api_url: 'boxlite-app docs setup',
  invalid_manifest: 'boxlite-app docs manifest',
  deploy_failed: 'boxlite-app docs deploy',
  stale_base: 'boxlite-app docs loop',
  sql_error: 'boxlite-app docs runtime',
  confirmation_required: 'boxlite-app docs rules',
};

function defaultNext(err: MicrocloudError, c: ErrorContext): string {
  const help = `\`boxlite-app ${c.command} --help\``;
  switch (err.code) {
    case 'unauthenticated':
      return 'save the key from the App prompt once: `BOXLITE_API_URL=<url> BOXLITE_API_KEY=<key> boxlite-app login`, then `boxlite-app whoami`';
    case 'not_found_app':
      return '`boxlite-app whoami` shows which App this key belongs to; then `boxlite-app init --app <that name>`';
    case 'not_found_env':
      return `\`boxlite-app app status\` lists the environments; pass --env <name>, or create it with \`boxlite-app app env create ${c.env}\``;
    case 'not_found':
      return notFoundNext(err, c);
    case 'forbidden':
      return `this App key cannot do that; \`boxlite-app whoami\` shows its scope${/main/.test(err.message) ? ', and DDL belongs in a new migration: `boxlite-app app db migration new <name>`' : ''}`;
    case 'unavailable':
      return `wait 30 s and rerun \`${c.commandLine}\` (at most 3 times); \`boxlite-app doctor\` checks the connection`;
    case 'conflict':
      return '`boxlite-app app deployments` shows what is running; wait for it with `boxlite-app app deployment <N> --follow`';
    case 'sql_error':
      return 'fix the SQL and rerun; `boxlite-app app db schema` lists tables and columns';
    case 'invalid_request':
    case 'usage':
      return `see ${help}`;
    case 'invalid_link':
      return 'delete .boxlite/link.json and run `boxlite-app init`';
    case 'internal':
      // BOXLITE_DEBUG prints the stack of a CLI error; a control-plane 500 has none to print.
      return c.clientSide
        ? `rerun with BOXLITE_DEBUG=1 to get the stack trace: \`BOXLITE_DEBUG=1 ${c.commandLine}\``
        : `the platform failed internally; wait 30 s and rerun \`${c.commandLine}\` (at most 3 times), then \`boxlite-app doctor\` and report the message to the user`;
    default:
      return `see ${help}, or \`boxlite-app doctor\``;
  }
}

function notFoundNext(err: MicrocloudError, c: ErrorContext): string {
  const m = err.message;
  if (/deployment/.test(m) || c.command.startsWith('app deployment') || c.command === 'app rollback') return '`boxlite-app app deployments` lists the deployment numbers';
  if (/schedule/.test(m)) return '`boxlite-app app schedule list` lists the schedules of the live spec';
  if (/no database/.test(m)) return 'add [database] to boxlite.toml, then `boxlite-app apply --yes`';
  if (/table/.test(m)) return '`boxlite-app app db schema` lists the tables';
  if (/volume/.test(m) || c.command.startsWith('app volume')) return '`boxlite-app app volume ls` lists volumes and files';
  if (/spec/.test(m)) return 'nothing is deployed yet: `boxlite-app deploy`';
  if (/service/.test(m)) return '`boxlite-app app services` lists the services';
  if (/snapshot/.test(m)) return '`boxlite-app app db snapshots` lists the snapshots';
  return `see \`boxlite-app ${c.command} --help\``;
}

export function refineError(err: MicrocloudError, c: ErrorContext): MicrocloudError {
  const next = err.next && !GENERIC_NEXT.test(err.next.trim()) ? err.next : defaultNext(err, c);
  const details = { ...err.details };
  if (!('docs' in details) && DOCS[err.code]) details.docs = DOCS[err.code];
  return new MicrocloudError(err.code, err.message, next, details);
}

/** Commander's own errors (unknown command/option, missing argument) as `usage` errors with a concrete next. */
export function usageError(message: string, command: string, appSubcommands: readonly string[]): MicrocloudError {
  const clean = message.replace(/^error:\s*/i, '').replace(/\s*\(Did you mean .*\)\s*$/s, '').trim();
  const suggestion = /\(Did you mean (.+?)\?\)/.exec(message)?.[1];
  const unknown = /unknown command '([^']+)'/.exec(clean)?.[1];
  let next = `see \`boxlite-app ${command ? `${command} ` : ''}--help\``;
  if (unknown && command === '' && appSubcommands.includes(unknown)) next = `\`${unknown}\` lives under app: \`boxlite-app app ${unknown}\``;
  else if (suggestion) next = `did you mean \`boxlite-app ${command ? `${command} ` : ''}${suggestion}\`?`;
  return new MicrocloudError('usage', clean, next);
}
