/**
 * Writes docs/cli-reference.md from the command definitions (commander tree + src/meta.ts) and
 * embeds it with agent/SKILL.md into src/generated/docs.ts for `boxlite-app docs`.
 *
 *   tsx scripts/gen-reference.ts           write both files
 *   tsx scripts/gen-reference.ts --check   exit 1 if either file is out of date
 */
import { ERROR_EXIT_CODES } from '@microcloud/shared';
import type { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildProgram } from '../src/cli.js';
import { metaOf, SHARED_TYPES } from '../src/meta.js';
import { VERSION } from '../src/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REFERENCE_PATH = join(root, 'docs', 'cli-reference.md');
export const EMBED_PATH = join(root, 'cli', 'src', 'generated', 'docs.ts');
export const SKILL_PATH = join(root, 'agent', 'SKILL.md');

const EXIT_MEANING: Record<string, string> = {
  unauthenticated: 'BOXLITE_API_KEY missing or not accepted',
  not_found_app: 'the App does not exist',
  not_found_env: 'the environment does not exist',
  not_found: 'a deployment, table, file, schedule… does not exist',
  forbidden: 'outside the key’s scope, or not allowed here (e.g. DDL on main)',
  unavailable: 'control plane or platform unreachable; wait 30 s and rerun (max 3 times)',
  invalid_manifest: 'boxlite.toml / project check failed; the body carries errors[]',
  deploy_failed: 'the deployment failed; the body carries deployment, step, cause, fix, log_tail',
  stale_base: 'someone changed the environment online since your last sync; `boxlite-app app pull`',
  confirmation_required: 'a destructive command ran without --yes; the body carries destroys[] and the exact command to rerun',
};

function usageOf(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  const args = cmd.registeredArguments.map((a) => (a.required ? `<${a.name()}${a.variadic ? '...' : ''}>` : `[${a.name()}${a.variadic ? '...' : ''}]`));
  return [...names, ...args, cmd.options.length ? '[options]' : ''].filter(Boolean).join(' ');
}

function pathOf(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

function leaves(cmd: Command): Command[] {
  const visible = cmd.commands.filter((c) => !(c as Command & { _hidden?: boolean })._hidden && c.name() !== 'help');
  if (!visible.length) return [cmd];
  return visible.flatMap(leaves);
}

const esc = (s: string): string => s.replace(/\|/g, '\\|');

function commandSection(cmd: Command): string {
  const meta = metaOf(cmd);
  const out = [`### \`${pathOf(cmd)}\``, '', cmd.description(), '', `Usage: \`${usageOf(cmd)}\``, ''];
  const opts = cmd.options.filter((o) => o.long !== '--help');
  if (opts.length) {
    out.push('| option | description | default |', '|---|---|---|');
    for (const o of opts) out.push(`| \`${esc(o.flags)}\` | ${esc(o.description)} | ${o.defaultValue !== undefined && o.defaultValue !== true ? `\`${String(o.defaultValue)}\`` : ''} |`);
    out.push('');
  }
  out.push(`- Network: ${meta?.online === false ? 'local only' : 'talks to the control plane'}`);
  if (meta?.destructive) out.push('- Destructive: prints what it destroys; needs `--yes` (without it: exit 10 `confirmation_required` in `--json` mode or without a terminal)');
  out.push(`- \`--json\`: \`${meta?.json ?? 'see the human output'}\``);
  const exits = [0, 1, ...(meta?.exits ?? [])].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  out.push(`- Exit codes: ${exits.join(', ')}`);
  if (meta?.examples?.length) {
    out.push('', '```sh', ...meta.examples, '```');
  }
  return out.join('\n');
}

export function generateReference(): string {
  const io = { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), isTTY: false };
  const program = buildProgram({ cwd: root, env: {}, io });
  const commands = leaves(program).filter((c) => c !== program);
  const missing = commands.filter((c) => !metaOf(c)).map(pathOf);
  if (missing.length) throw new Error(`commands without describe() metadata: ${missing.join(', ')}`);

  const out: string[] = [
    '# boxlite-app CLI reference',
    '',
    `Generated from the command definitions by \`cli/scripts/gen-reference.ts\` (CLI ${VERSION}); do not edit by hand. Offline: \`boxlite-app docs reference [command…]\`.`,
    '',
    '## Conventions',
    '',
    '- Global options on every command: `--json`, `--env <name>` (default: `.boxlite/link.json`, else `main`).',
    '- The App is taken from `.boxlite/link.json`, then `BOXLITE_APP`, then the App the key belongs to. Credentials: `BOXLITE_API_KEY`, `BOXLITE_API_URL`.',
    '- `--json`: exit 0 prints exactly one JSON document on stdout. Any other exit prints nothing on stdout and one `{"error": {…}}` object on stderr. `--follow` modes stream NDJSON, one object per line.',
    '- Errors always carry `code`, `message` and `next` (a runnable command or a file edit), often `docs` (a `boxlite-app docs` topic) and code-specific fields.',
    '- Human mode ends successful commands with a `next:` line when there is an obvious next step.',
    '- Nothing printed ever contains an App key, box token or database password: output is masked (`bxl_app_…abcd`, `postgresql://user:****@host`).',
    '',
    '## Exit codes',
    '',
    '| exit | error code | meaning |',
    '|---|---|---|',
    '| 0 | | success |',
    '| 1 | `usage`, `invalid_request`, `conflict`, `sql_error`, … | any other error; `next` says what to do |',
  ];
  for (const [code, exit] of Object.entries(ERROR_EXIT_CODES).sort((a, b) => a[1] - b[1])) out.push(`| ${exit} | \`${code}\` | ${EXIT_MEANING[code] ?? ''} |`);
  out.push('', '## Types', '', 'Shapes the `--json` lines below refer to by name.', '');
  for (const [name, shape] of Object.entries(SHARED_TYPES)) out.push(`- \`${name}\`: \`${shape}\``);
  out.push('', '## Commands', '');
  for (const c of commands) out.push(commandSection(c), '');
  return `${out.join('\n').trimEnd()}\n`;
}

export function generateEmbed(reference: string, skill: string): string {
  return [
    '// Generated by cli/scripts/gen-reference.ts from agent/SKILL.md and docs/cli-reference.md. Do not edit.',
    `export const SKILL_MD = ${JSON.stringify(skill)};`,
    `export const REFERENCE_MD = ${JSON.stringify(reference)};`,
    '',
  ].join('\n');
}

function main(): void {
  const reference = generateReference();
  const embed = generateEmbed(reference, readFileSync(SKILL_PATH, 'utf8'));
  if (process.argv.includes('--check')) {
    const stale = [
      [REFERENCE_PATH, reference],
      [EMBED_PATH, embed],
    ].filter(([path, text]) => {
      try {
        return readFileSync(path!, 'utf8') !== text;
      } catch {
        return true;
      }
    });
    if (stale.length) {
      console.error(`out of date: ${stale.map(([p]) => p).join(', ')}; run \`pnpm --filter @microcloud/cli gen:reference\``);
      process.exit(1);
    }
    return;
  }
  writeFileSync(REFERENCE_PATH, reference);
  writeFileSync(EMBED_PATH, embed);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
