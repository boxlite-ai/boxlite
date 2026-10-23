import { MANIFEST_FILE, MicrocloudError, SECRET_REF_RE, VARIABLE_NAME_RE } from '@microcloud/shared';
import type { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { table } from '../output.js';
import { editToml, ensureTable, type TomlDoc } from '../toml-edit.js';
import { readLocalProject, readStdin } from './common.js';

/** `[variables]` for main, `[env.<name>.variables]` otherwise — same for `secrets`. */
function tablePath(ctx: Ctx, table: 'variables' | 'secrets'): string[] {
  return ctx.envName === 'main' ? [table] : ['env', ctx.envName, table];
}

function parsePair(text: string): [string, string] {
  const eq = text.indexOf('=');
  if (eq <= 0) throw new MicrocloudError('usage', `expected KEY=VALUE, got "${text}"`, '`boxlite-app app vars set LOG_LEVEL=info`');
  return [text.slice(0, eq), text.slice(eq + 1)];
}

function assertName(name: string): void {
  if (!VARIABLE_NAME_RE.test(name)) throw new MicrocloudError('invalid_variable', `"${name}" is not a valid variable name (${VARIABLE_NAME_RE})`, `use upper case, digits and _: ${name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`);
}

const PUBLISH = '`boxlite-app plan`, then `boxlite-app apply --yes` (or `deploy`) to publish';

/** Live values from the environment's current spec; secrets masked; local edits not yet published are flagged. */
async function varsList(ctx: Ctx): Promise<void> {
  const live = await (await ctx.appApi()).listVars();
  const local = await readLocalProject(ctx);
  const localVars = local?.manifest.variables;
  const localSecrets = local?.manifest.secrets;
  const out = live.map((v) => {
    let local_change: string | null = null;
    if (localVars && v.source === 'boxlite.toml') local_change = v.name in localVars ? (localVars[v.name] !== v.value ? 'changed' : null) : 'removed';
    if (localSecrets && v.secret && v.source.startsWith('secret ')) local_change = v.name in localSecrets ? (`secret ${localSecrets[v.name]}` !== v.source ? 'changed' : null) : 'removed';
    return { ...v, local_change };
  });
  const names = new Set(live.map((v) => v.name));
  for (const [name, value] of Object.entries(localVars ?? {})) if (!names.has(name)) out.push({ name, value, secret: false, source: 'boxlite.toml', resolved: true, local_change: 'added' });
  for (const [name, ref] of Object.entries(localSecrets ?? {})) if (!names.has(name)) out.push({ name, value: null, secret: true, source: `secret ${ref}`, resolved: false, local_change: 'added' });
  ctx.out.data(out);
  if (!out.length) ctx.out.line('no variables');
  const rows = out.map((v) => [v.name, v.secret ? (v.resolved ? '********' : '(missing)') : (v.value ?? '(set by the platform)'), v.source, v.local_change ? `local: ${v.local_change}, not published` : '']);
  for (const line of table(rows)) ctx.out.line(line);
  const missing = out.filter((v) => v.secret && !v.resolved && !v.local_change);
  if (missing.length) ctx.out.next(`ask the user to add ${missing.map((v) => v.source.replace(/^secret /, '')).join(', ')} in the console; never put secret values in files`);
  else if (out.some((v) => v.local_change)) ctx.out.next(PUBLISH);
}

/** dotenv subset: KEY=VALUE, optional `export `, quotes, `#` comments and blank lines. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]!] = value;
  }
  return out;
}

async function rewrite(ctx: Ctx, mutate: (doc: TomlDoc) => void): Promise<boolean> {
  const path = join(ctx.cwd, MANIFEST_FILE);
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    throw new MicrocloudError('missing_manifest', 'boxlite.toml not found', 'run `boxlite-app init` here first');
  }
  const edit = editToml(source, mutate);
  await writeFile(path, edit.text);
  if (edit.droppedComments) ctx.out.note('note: boxlite.toml was rewritten; its comments were dropped');
  return edit.droppedComments;
}

async function varsSet(ctx: Ctx, pairs: string[]): Promise<void> {
  const values = Object.fromEntries(pairs.map(parsePair));
  for (const k of Object.keys(values)) assertName(k);
  const dropped = await rewrite(ctx, (doc) => Object.assign(ensureTable(doc, tablePath(ctx, 'variables')), values));
  for (const [k, v] of Object.entries(values)) ctx.out.line(`set ${k}=${v}${ctx.envName === 'main' ? '' : ` (env ${ctx.envName})`}`);
  ctx.out.data({ file: MANIFEST_FILE, env: ctx.envName, set: values, comments_dropped: dropped });
  ctx.out.next(PUBLISH);
}

async function varsUnset(ctx: Ctx, names: string[]): Promise<void> {
  const removed: string[] = [];
  const dropped = await rewrite(ctx, (doc) => {
    const table = ensureTable(doc, tablePath(ctx, 'variables'));
    for (const n of names) if (n in table) (delete table[n], removed.push(n));
  });
  for (const n of names) ctx.out.line(removed.includes(n) ? `unset ${n}` : `${n} was not set`);
  ctx.out.data({ file: MANIFEST_FILE, env: ctx.envName, unset: removed, comments_dropped: dropped });
  if (removed.length) ctx.out.next(PUBLISH);
}

async function varsImport(ctx: Ctx, file: string, opts: { dryRun?: boolean }): Promise<void> {
  const values = parseDotenv(await readFile(join(ctx.cwd, file), 'utf8'));
  for (const k of Object.keys(values)) assertName(k);
  const n = Object.keys(values).length;
  if (opts.dryRun) {
    for (const [k, v] of Object.entries(values)) ctx.out.line(`would set ${k}=${v}`);
    ctx.out.data({ file: MANIFEST_FILE, env: ctx.envName, would_set: values });
    return;
  }
  const dropped = await rewrite(ctx, (doc) => Object.assign(ensureTable(doc, tablePath(ctx, 'variables')), values));
  ctx.out.line(`imported ${n} variable${n === 1 ? '' : 's'} from ${file}`);
  ctx.out.data({ file: MANIFEST_FILE, env: ctx.envName, set: values, comments_dropped: dropped });
  ctx.out.next(PUBLISH);
}

async function secretsRef(ctx: Ctx, name: string, ref: string): Promise<void> {
  assertName(name);
  if (!SECRET_REF_RE.test(ref)) throw new MicrocloudError('invalid_secret_ref', `"${ref}" must look like app/<name> or org/<name>`, `\`boxlite-app app secrets ref ${name} app/${ref.replace(/^\/+/, '') || 'name'}\``);
  const dropped = await rewrite(ctx, (doc) => {
    ensureTable(doc, tablePath(ctx, 'secrets'))[name] = ref;
  });
  ctx.out.line(`secret ${name} → ${ref}`);
  ctx.out.data({ file: MANIFEST_FILE, env: ctx.envName, secrets: { [name]: ref }, comments_dropped: dropped });
  ctx.out.next(ref.startsWith('app/') ? `if it is not stored yet: \`printf %s "$VALUE" | boxlite-app app secrets set ${ref.slice(4)}\`; then ${PUBLISH}` : `an org admin sets ${ref}; then ${PUBLISH}`);
}

/** Stores an App secret from stdin: a value never travels as an argument (shell history, process list). */
async function secretsSet(ctx: Ctx, name: string): Promise<void> {
  const short = name.replace(/^app\//, '');
  if ((ctx.io.stdin as { isTTY?: boolean }).isTTY) {
    throw new MicrocloudError('usage', 'pipe the value in on stdin; it is never taken as an argument', `\`printf %s "$VALUE" | boxlite-app app secrets set ${short}\``);
  }
  // A single trailing newline is what `echo` adds, not part of the secret.
  const value = (await readStdin(ctx)).replace(/\r?\n$/, '');
  if (!value) throw new MicrocloudError('usage', 'nothing came in on stdin', `\`printf %s "$VALUE" | boxlite-app app secrets set ${short}\``);
  const r = await (await ctx.appApi()).setSecret(short, value);
  ctx.out.line(`${r.created ? 'stored' : 'updated'} ${r.name} (${value.length} characters; the value is never shown again)`);
  ctx.out.data(r);
  ctx.out.next(`reference it: \`boxlite-app app secrets ref <ENV_NAME> ${r.name}\`, then ${PUBLISH}${r.created ? '' : '; running services see the new value after the next deploy'}`);
}

async function secretsList(ctx: Ctx): Promise<void> {
  const s = await (await ctx.appApi()).secrets();
  ctx.out.data(s);
  const rows = [...s.app.map((x) => [x.name, 'this App', x.updated_at]), ...s.org.map((x) => [x.name, 'organization', x.updated_at])];
  if (!rows.length) ctx.out.line('no secrets yet');
  else for (const l of table([['NAME', 'SCOPE', 'UPDATED'], ...rows])) ctx.out.line(l);
  ctx.out.next('store one: `printf %s "$VALUE" | boxlite-app app secrets set <name>`; use one: `boxlite-app app secrets ref <ENV_NAME> app/<name>`');
}

async function secretsRm(ctx: Ctx, name: string): Promise<void> {
  const short = name.replace(/^app\//, '');
  if (!(await ctx.confirmDestructive({ action: `delete the App secret app/${short}`, destroys: [`its value`, `[secrets] that reference app/${short} stop resolving on the next deploy`], undo: 'store it again with `app secrets set`' }))) return;
  await (await ctx.appApi()).deleteSecret(short);
  ctx.out.line(`deleted app/${short}`);
  ctx.out.data({ deleted: `app/${short}` });
}

export function registerVars(app: Command, make: MakeCtx): void {
  const vars = app.command('vars').description('variables: `list` shows the live values; set/unset/import edit [variables] in boxlite.toml (publish with apply or deploy)');
  describe(vars.command('list').description('live variables of the environment with their source; secrets masked; unpublished local edits flagged').action(async (_o: unknown, cmd: Command) => varsList(await make(cmd))), {
    json: '{ name, value: string | null, secret: boolean, source: string, resolved: boolean, local_change: "added" | "changed" | "removed" | null }[]',
    exits: [2, 3],
    online: true,
  });
  describe(
    vars
      .command('set <pairs...>')
      .description('set KEY=VALUE pairs in boxlite.toml')
      .action(async (pairs: string[], _o: unknown, cmd: Command) => varsSet(await make(cmd), pairs)),
    { json: '{ file, env, set: Record<string, string>, comments_dropped: boolean }', online: false },
  );
  describe(
    vars
      .command('unset <names...>')
      .description('remove variables from boxlite.toml')
      .action(async (names: string[], _o: unknown, cmd: Command) => varsUnset(await make(cmd), names)),
    { json: '{ file, env, unset: string[], comments_dropped: boolean }', online: false },
  );
  describe(
    vars
      .command('import <file>')
      .description('import KEY=VALUE lines from a dotenv-style file into boxlite.toml')
      .option('--dry-run', 'print what would change without writing')
      .action(async (file: string, opts: { dryRun?: boolean }, cmd: Command) => varsImport(await make(cmd), file, opts)),
    { json: '{ file, env, set | would_set: Record<string, string>, comments_dropped?: boolean }', online: false },
  );

  const secrets = app.command('secrets').description('App secrets (values stored on the platform, never shown again) and [secrets] references in boxlite.toml');
  describe(
    secrets
      .command('set <name>')
      .description('store an App secret from stdin, e.g. printf %s "$KEY" | boxlite-app app secrets set stripe (referenced as app/stripe)')
      .action(async (name: string, _o: unknown, cmd: Command) => secretsSet(await make(cmd), name)),
    { json: '{ name: "app/<name>", updated_at, created: boolean }', exits: [2, 3, 4], online: true, examples: ['printf %s "$STRIPE_SECRET_KEY" | boxlite-app app secrets set stripe'] },
  );
  describe(
    secrets.command('list').description('secret names usable as references: the App\'s own (app/…) and its organization\'s (org/…); never values').action(async (_o: unknown, cmd: Command) => secretsList(await make(cmd))),
    { json: '{ app: { name, updated_at }[], org: { name, updated_at }[] }', exits: [2, 3], online: true },
  );
  describe(
    secrets
      .command('rm <name>')
      .description('delete an App secret')
      .option('-y, --yes', 'skip the confirmation')
      .action(async (name: string, _o: unknown, cmd: Command) => secretsRm(await make(cmd), name)),
    { json: '{ deleted: "app/<name>" }', exits: [2, 3, 4], online: true },
  );
  describe(
    secrets
      .command('ref <name> <ref>')
      .description('map NAME to a secret in boxlite.toml, e.g. STRIPE_SECRET_KEY app/stripe (or org/openai)')
      .action(async (name: string, ref: string, _o: unknown, cmd: Command) => secretsRef(await make(cmd), name, ref)),
    { json: '{ file, env, secrets: Record<string, string>, comments_dropped: boolean }', online: false },
  );
}
