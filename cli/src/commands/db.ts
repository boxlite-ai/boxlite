import { MANIFEST_FILE, MicrocloudError, nextMigrationName, parseManifest, readMigrations, type MigrationFile } from '@microcloud/shared';
import type { Command } from 'commander';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppliedMigration, SqlResult } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { localDatabaseUrl, startDbBridge, type BridgeSocket, type DbBridge } from '../dbproxy.js';
import { abortOnSigint } from '../follow.js';
import { describe } from '../meta.js';
import { formatAgo, formatBytes, formatValue, table } from '../output.js';
import { parseInteger, readStdin } from './common.js';

/** Widest a cell gets in a human table; JSON output is never truncated. */
const CELL_MAX = 60;

function cellText(v: unknown): string {
  const s = v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : formatValue(v);
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > CELL_MAX ? `${flat.slice(0, CELL_MAX - 1)}…` : flat;
}

export function resultTable(result: Pick<SqlResult, 'columns' | 'rows'>): string[] {
  const columns = result.columns ?? [];
  if (!columns.length) return [];
  const rows = (result.rows ?? []).map((r) => (Array.isArray(r) ? r : columns.map((c) => (r as Record<string, unknown>)[c])).map(cellText));
  return table([columns, columns.map((c, i) => '-'.repeat(Math.max(c.length, ...rows.map((r) => (r[i] ?? '').length)))), ...rows]);
}

function printResult(ctx: Ctx, result: SqlResult & { truncated?: boolean }): void {
  ctx.out.data(result);
  for (const line of resultTable(result)) ctx.out.line(line);
  ctx.out.line(`${result.row_count ?? result.rows?.length ?? 0} row${result.row_count === 1 ? '' : 's'} · ${result.elapsed_ms ?? 0} ms${result.truncated ? ' · truncated to 1000 rows' : ''}`);
}


/** The SQL text from the argument, `--file`, or stdin when the query is `-` (never implicitly: a silent pipe would hang). */
async function sqlText(ctx: Ctx, query: string | undefined, file: string | undefined): Promise<string> {
  if (query !== undefined && file !== undefined) throw new MicrocloudError('usage', 'pass either a query or --file, not both', '`boxlite-app app sql --file q.sql`');
  let text: string | undefined;
  if (file !== undefined) {
    try {
      text = await readFile(resolve(ctx.cwd, file), 'utf8');
    } catch {
      throw new MicrocloudError('not_found', `cannot read ${file}`, 'check the path (relative to the current directory)');
    }
  } else if (query === '-') text = await readStdin(ctx);
  else text = query;
  if (!text?.trim()) throw new MicrocloudError('usage', 'no SQL given', '`boxlite-app app sql "select count(*) from deals"`, `--file q.sql`, or pipe it: `cat q.sql | boxlite-app app sql -`');
  return text;
}

async function sql(ctx: Ctx, query: string | undefined, opts: { write?: boolean; explain?: boolean; file?: string }): Promise<void> {
  const text = await sqlText(ctx, query, opts.file);
  printResult(ctx, await (await ctx.appApi()).sql(text, { write: opts.write === true, explain: opts.explain === true }));
}

async function info(ctx: Ctx): Promise<void> {
  const db = await (await ctx.appApi()).dbInfo();
  ctx.out.data(db);
  if (db.status === 'none') {
    ctx.out.line('no database');
    ctx.out.next('add [database] to boxlite.toml, then `boxlite-app apply --yes`');
    return;
  }
  ctx.out.line(`database ${db.status}${db.branch ? ` · branch ${db.branch}` : ''}${db.size_bytes != null ? ` · ${formatBytes(db.size_bytes)}` : ''}`);
  if (db.host) ctx.out.line(`  host      ${db.host}`);
  if (db.database) ctx.out.line(`  database  ${db.database}`);
  if (db.user) ctx.out.line(`  user      ${db.user}`);
  ctx.out.next('`boxlite-app app db schema`, or `boxlite-app app dev` for a local DATABASE_URL in .env.local');
}

async function schema(ctx: Ctx, tableName?: string): Promise<void> {
  const data = await (await ctx.appApi()).dbSchema(tableName);
  ctx.out.data(data);
  if (ctx.json) return;
  const tables = ((data as { tables?: unknown[] }).tables ?? [data]) as {
    name: string;
    columns?: { name: string; type: string; nullable?: boolean; default?: string | null }[];
    indexes?: { name: string; definition: string }[];
    constraints?: { name: string; definition: string }[];
    row_estimate?: number | null;
  }[];
  if (!tables.length) {
    ctx.out.line('no tables yet');
    ctx.out.next('`boxlite-app app db migration new init`, write CREATE TABLE there, then `boxlite-app apply --yes`');
  }
  for (const t of tables) {
    ctx.out.line(t.row_estimate != null ? `${t.name}  (~${t.row_estimate} rows)` : t.name);
    for (const c of t.columns ?? []) {
      const extra = [c.nullable === false ? 'not null' : '', c.default ? `default ${c.default}` : ''].filter(Boolean).join(', ');
      ctx.out.line(`  ${c.name.padEnd(20)} ${c.type}${extra ? `  ${extra}` : ''}`);
    }
    for (const i of t.indexes ?? []) ctx.out.line(`  index ${i.definition}`);
    for (const k of t.constraints ?? []) ctx.out.line(`  constraint ${k.name}: ${k.definition}`);
  }
}

async function rows(ctx: Ctx, tableName: string, opts: { where?: string; limit?: string; offset?: string }): Promise<void> {
  const data = await (await ctx.appApi()).dbRows(tableName, {
    where: opts.where,
    limit: opts.limit !== undefined ? parseInteger(opts.limit, '--limit') : undefined,
    offset: opts.offset !== undefined ? parseInteger(opts.offset, '--offset') : undefined,
  });
  if ('columns' in data) {
    printResult(ctx, data);
    return;
  }
  const list = (data.rows ?? []) as Record<string, unknown>[];
  const columns = list.length ? Object.keys(list[0]!) : [];
  printResult(ctx, { columns, rows: list.map((r) => columns.map((c) => r[c])), elapsed_ms: 0, row_count: list.length });
}

async function localMigrations(ctx: Ctx): Promise<{ dir: string; files: MigrationFile[]; hasDatabase: boolean } | null> {
  let source: string;
  try {
    source = await readFile(join(ctx.cwd, MANIFEST_FILE), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseManifest(source, ctx.envName);
  const dir = parsed.manifest?.database?.migrations ?? 'migrations/';
  if (!parsed.manifest) return { dir, files: [], hasDatabase: false };
  const read = await readMigrations(ctx.cwd, { ...parsed.manifest, database: { migrations: dir } });
  return { dir, files: read.files, hasDatabase: parsed.manifest.database !== null };
}

export type DiffStatus = 'applied' | 'pending' | 'changed' | 'missing_locally';

export interface MigrationDiff {
  file: string;
  status: DiffStatus;
  deployment: number | null;
  applied_at: string | null;
}

/** Local files against what the database recorded in public.boxlite_migrations. */
export function diffMigrations(local: readonly MigrationFile[], applied: readonly AppliedMigration[]): MigrationDiff[] {
  const done = new Map(applied.map((a) => [a.file, a]));
  const out: MigrationDiff[] = local.map((f) => {
    const a = done.get(f.file);
    done.delete(f.file);
    if (!a) return { file: f.file, status: 'pending', deployment: null, applied_at: null };
    return { file: f.file, status: a.sha256 === f.sha256 ? 'applied' : 'changed', deployment: a.deployment, applied_at: a.applied_at };
  });
  for (const a of done.values()) out.push({ file: a.file, status: 'missing_locally', deployment: a.deployment, applied_at: a.applied_at });
  return out.sort((x, y) => x.file.localeCompare(y.file));
}

function printDiff(ctx: Ctx, list: MigrationDiff[], dir: string): void {
  for (const line of table(list.map((m) => [m.file, m.status, m.deployment != null ? `#${m.deployment}` : '', m.applied_at ? formatAgo(m.applied_at) : '']))) ctx.out.line(line);
  const changed = list.filter((m) => m.status === 'changed');
  const pending = list.filter((m) => m.status === 'pending');
  const missing = list.filter((m) => m.status === 'missing_locally');
  if (changed.length) ctx.out.next(`restore ${changed.map((m) => `${dir}${m.file}`).join(', ')} to the applied contents (\`boxlite-app app clone <app>\` has them) and add the change as a new file: \`boxlite-app app db migration new <name>\``);
  else if (missing.length) ctx.out.next(`the database has ${missing.map((m) => m.file).join(', ')} but ${dir} does not: \`boxlite-app app clone <app>\` into an empty directory and copy them back`);
  else if (pending.length) ctx.out.next('`boxlite-app apply --yes` (or `boxlite-app deploy`) applies the pending files');
}

/** Online status per file, merged with the local directory when the project is here. */
async function migrations(ctx: Ctx): Promise<void> {
  const api = await ctx.appApi();
  const local = await localMigrations(ctx);
  if (local?.files.length) {
    const list = diffMigrations(local.files, await api.dbApplied());
    ctx.out.data(list);
    if (!list.length) ctx.out.line('no migrations');
    printDiff(ctx, list, local.dir);
    return;
  }
  const list = await api.dbMigrations();
  ctx.out.data(list);
  if (list.length === 0) {
    ctx.out.line('no migrations');
    ctx.out.next('`boxlite-app app db migration new init`');
  }
  for (const line of table(list.map((m) => [m.file, m.status, m.deployment != null ? `#${m.deployment}` : '']))) ctx.out.line(line);
}

async function diff(ctx: Ctx): Promise<void> {
  const local = await localMigrations(ctx);
  if (!local) throw new MicrocloudError('missing_manifest', 'boxlite.toml not found here', 'run this in the project directory (where boxlite.toml is)');
  const list = diffMigrations(local.files, await (await ctx.appApi()).dbApplied());
  const changed = list.filter((m) => m.status === 'changed');
  if (changed.length) {
    if (!ctx.json) printDiff(ctx, list, local.dir);
    throw new MicrocloudError('invalid_manifest', `${changed.length} applied migration(s) were edited locally: ${changed.map((m) => m.file).join(', ')}`, `restore ${changed.map((m) => `${local.dir}${m.file}`).join(', ')} and put the change in a new file (\`boxlite-app app db migration new <name>\`)`, {
      migrations: list,
      errors: changed.map((m) => ({ file: `${local.dir}${m.file}`, rule: 'migration_changed', message: `${m.file} was applied in #${m.deployment ?? '?'} with different contents` })),
      printed: !ctx.json,
    });
  }
  ctx.out.data(list);
  if (!list.length) ctx.out.line('no migrations locally or in the database');
  else if (list.every((m) => m.status === 'applied')) ctx.out.line(`in sync: ${list.length} migration(s) applied`);
  printDiff(ctx, list, local.dir);
}

async function migrationNew(ctx: Ctx, name: string): Promise<void> {
  const local = await localMigrations(ctx);
  if (!local) throw new MicrocloudError('missing_manifest', 'boxlite.toml not found', 'run `boxlite-app init` first');
  if (!local.hasDatabase) ctx.out.note(`note: boxlite.toml has no [database] section; add it so ${local.dir} runs on deploy`);
  const file = nextMigrationName(local.files, name);
  await mkdir(join(ctx.cwd, local.dir), { recursive: true });
  await writeFile(join(ctx.cwd, local.dir, file), `-- ${name}\n`, { flag: 'wx' });
  const sha256 = createHash('sha256').update(`-- ${name}\n`).digest('hex');
  ctx.out.data({ file: `${local.dir}${file}`, sha256 });
  ctx.out.line(`created ${local.dir}${file}`);
  ctx.out.next(`write the SQL in ${local.dir}${file}, then \`boxlite-app check\` and \`boxlite-app apply --yes\``);
}

async function snapshot(ctx: Ctx, opts: { message?: string }): Promise<void> {
  if (!opts.message) throw new MicrocloudError('usage', 'a message is required', '`boxlite-app app db snapshot -m "before import"`');
  const snap = await (await ctx.appApi()).createDbSnapshot(opts.message);
  ctx.out.data(snap);
  ctx.out.line(`snapshot ${snap.id} created`);
  ctx.out.next(`restore it later with \`boxlite-app app db restore --snapshot ${snap.id} --yes\``);
}

async function snapshots(ctx: Ctx): Promise<void> {
  const list = await (await ctx.appApi()).dbSnapshots();
  ctx.out.data(list);
  if (list.length === 0) ctx.out.line('no snapshots');
  for (const line of table(list.map((s) => [s.id, formatAgo(s.created_at), s.message ?? '']))) ctx.out.line(line);
}

async function restore(ctx: Ctx, opts: { to?: string; snapshot?: string }): Promise<void> {
  if (!opts.to && !opts.snapshot) throw new MicrocloudError('usage', 'pass --to <iso8601> or --snapshot <id>', '`boxlite-app app db snapshots` lists snapshot ids');
  const target = opts.snapshot ? `snapshot ${opts.snapshot}` : `point in time ${opts.to}`;
  const app = await ctx.appName();
  const ok = await ctx.confirmDestructive({
    action: `restore the ${app}/${ctx.envName} database to ${target}`,
    destroys: [`every row and schema change written after ${target}`],
    undo: `the current state is kept as Neon branch ${ctx.envName}-before-restore-<time>`,
  });
  if (!ok) {
    ctx.out.line('cancelled');
    return;
  }
  const result = await (await ctx.appApi()).dbRestore({ to: opts.to, snapshot: opts.snapshot });
  ctx.out.data(result ?? { restored: target });
  ctx.out.line(`restored to ${target}`);
  ctx.out.next('`boxlite-app app db migrations` to check which migrations the restored database has');
}

async function reset(ctx: Ctx): Promise<void> {
  const app = await ctx.appName();
  if (ctx.envName === 'main') throw new MicrocloudError('forbidden', 'db reset is not available on main', 'on main use `boxlite-app app db restore --to <iso8601> --yes`; reset works on other environments (`--env <name>`)');
  const api = await ctx.appApi();
  const schemaInfo = (await api.dbSchema().catch(() => ({ tables: [] }))) as { tables?: { name: string }[] };
  const tables = (schemaInfo.tables ?? []).map((t) => t.name);
  const ok = await ctx.confirmDestructive({
    action: `reset the ${app}/${ctx.envName} database`,
    destroys: [tables.length ? `tables ${tables.join(', ')} and every row in them` : 'the public schema (no tables yet)', 'the record of applied migrations (they run again on the next apply/deploy)'],
    undo: 'a snapshot is taken first; `boxlite-app app db restore --snapshot <id> --yes` brings it back',
  });
  if (!ok) {
    ctx.out.line('cancelled');
    return;
  }
  const result = await api.dbReset();
  ctx.out.data(result);
  ctx.out.line(`reset ${result.reset}: dropped ${result.dropped_tables.length} table(s); snapshot ${result.snapshot} keeps the old data`);
  ctx.out.next(`\`boxlite-app apply --yes --env ${ctx.envName}\` re-runs the migrations`);
}

/**
 * Starts the local Postgres port for this App env (`db proxy`, `app dev`). Fails before listening
 * when the env has no database or the key is wrong (the WebSocket itself cannot say why).
 */
export async function openDbProxy(ctx: Ctx, opts: { port: number; write: boolean }): Promise<{ bridge: DbBridge; url: string; database: string }> {
  const api = await ctx.appApi();
  const db = await api.dbInfo();
  if (db.status === 'none' || !db.database) throw new MicrocloudError('not_found', `${ctx.envName} has no database`, 'add [database] to boxlite.toml, then `boxlite-app apply --yes`');
  const session = randomUUID();
  let bridge: DbBridge;
  try {
    bridge = await startDbBridge(() => api.dbSocket(opts.write, session) as unknown as BridgeSocket, opts.port, { onError: (m) => ctx.out.note(m) });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new MicrocloudError('conflict', `127.0.0.1:${opts.port} is already in use (a local Postgres?)`, `pick another port: \`boxlite-app app db proxy --port ${opts.port === 5432 ? 15432 : opts.port + 1}\``);
    }
    throw err;
  }
  return { bridge, url: localDatabaseUrl(bridge.port, db.database), database: db.database };
}

async function proxy(ctx: Ctx, opts: { port?: string; write?: boolean }): Promise<void> {
  const port = opts.port !== undefined ? parseInteger(opts.port, '--port') : 5432;
  const write = opts.write === true;
  const app = await ctx.appName();
  const { bridge, url } = await openDbProxy(ctx, { port, write });
  const role = write ? 'read-write, as the database owner' : 'read-only, as boxlite_reader';
  ctx.out.stream({ event: 'listening', app, env: ctx.envName, host: '127.0.0.1', port: bridge.port, role: write ? 'owner' : 'reader', database_url: url });
  ctx.out.line(`Postgres for ${app}/${ctx.envName} on 127.0.0.1:${bridge.port} (${role}; authenticated with your App key)`);
  ctx.out.line(`DATABASE_URL=${url}`);
  if (write && ctx.envName === 'main') ctx.out.line('schema changes (DDL) are refused on main: they go through migrations/');
  ctx.out.line('every connection is recorded in the App\'s Activity; Ctrl-C stops the proxy');
  ctx.out.next(`\`psql "${url}"\` in another terminal`);
  const { signal, dispose } = abortOnSigint();
  const onTerm = () => process.emit('SIGINT');
  process.once('SIGTERM', onTerm);
  await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  dispose();
  process.off('SIGTERM', onTerm);
  await bridge.close();
  ctx.out.line('proxy stopped');
}

async function exportDb(ctx: Ctx, opts: { table?: string; format?: string; output?: string }): Promise<void> {
  const format = opts.format ?? (opts.table ? 'csv' : 'sql');
  if (format !== 'csv' && format !== 'sql') throw new MicrocloudError('usage', '--format must be csv or sql', '`boxlite-app app db export --table deals --format csv`');
  if (format === 'csv' && !opts.table) throw new MicrocloudError('usage', 'a CSV export is one table: pass --table', '`boxlite-app app db export --table <table>`, or `boxlite-app app db export --format sql` for the whole database');
  if (ctx.json && !opts.output) throw new MicrocloudError('usage', 'with --json the export needs -o <file> (stdout carries the JSON result)', '`boxlite-app app db export --format sql -o dump.sql --json`');
  const res = await (await ctx.appApi()).dbExport({ table: opts.table, format });
  if (!res.body) throw new MicrocloudError('unavailable', 'the control plane sent no data', 'rerun the export');
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  if (!opts.output) {
    await pipeline(body, ctx.io.stdout, { end: false });
    return;
  }
  const file = resolve(ctx.cwd, opts.output);
  const partial = `${file}.partial`;
  try {
    await pipeline(body, createWriteStream(partial));
    await rename(partial, file);
  } catch (err) {
    await rm(partial, { force: true });
    throw new MicrocloudError('unavailable', `the export stopped before it finished: ${(err as Error).message}`, 'rerun the export; nothing was written to the output file');
  }
  const bytes = (await stat(file)).size;
  ctx.out.data({ file: opts.output, format, table: opts.table ?? null, bytes });
  ctx.out.line(`wrote ${opts.output} (${formatBytes(bytes)}, ${format}${opts.table ? `, table ${opts.table}` : ', whole database'})`);
}

async function importDb(ctx: Ctx, file: string, opts: { table: string }): Promise<void> {
  const path = resolve(ctx.cwd, file);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new MicrocloudError('not_found', `cannot read ${file}`, 'check the path (relative to the current directory)');
  }
  const app = await ctx.appName();
  const brief = {
    action: `import ${file} (${formatBytes(size)} of CSV) into table ${opts.table} of ${app}/${ctx.envName}`,
    destroys: [`nothing is replaced: the rows are added to ${opts.table}; if one row fails (constraint, type), none are added`],
    undo: 'a snapshot is taken first; `boxlite-app app db restore --snapshot <id> --yes` brings the table back',
  };
  // On main an import always needs an explicit --yes, even on a terminal.
  if (ctx.envName === 'main' && !ctx.yes) {
    for (const l of [`This will ${brief.action}:`, ...brief.destroys.map((d) => `  - ${d}`), `Undo: ${brief.undo}`]) ctx.out.note(l);
    throw new MicrocloudError('confirmation_required', `refusing to import into main without --yes`, `rerun as \`${ctx.commandLine(['--yes'])}\` once the user agreed`, { action: brief.action, destroys: brief.destroys, undo: brief.undo, command: ctx.commandLine(['--yes']) });
  }
  if (!(await ctx.confirmDestructive(brief))) {
    ctx.out.line('cancelled');
    return;
  }
  const result = await (await ctx.appApi()).dbImport(opts.table, createReadStream(path));
  ctx.out.data(result);
  ctx.out.line(`imported ${result.rows} row${result.rows === 1 ? '' : 's'} into ${result.table} (${result.columns.join(', ')})`);
  ctx.out.next(`\`boxlite-app app db rows ${result.table}\`; undo with \`boxlite-app app db restore --snapshot ${result.snapshot} --yes\``);
}

export function registerDb(app: Command, make: MakeCtx): void {
  describe(
    app
      .command('sql [query]')
      .description('run SQL against the environment database (read-only unless --write); query, --file, or stdin (`-`)')
      .option('-f, --file <path>', 'read the SQL from a file')
      .option('--write', 'allow statements that modify data (DDL only on non-main environments)')
      .option('--explain', 'return the query plan instead of rows')
      .action(async (query: string | undefined, opts: { write?: boolean; explain?: boolean; file?: string }, cmd: Command) => sql(await make(cmd), query, opts)),
    {
      json: '{ columns: string[], rows: unknown[][], row_count: number, elapsed_ms: number, truncated: boolean }',
      exits: [2, 3, 4, 5],
      online: true,
      examples: ['boxlite-app app sql "select count(*) from deals"', 'boxlite-app app sql --file q.sql --json', 'cat q.sql | boxlite-app app sql -'],
    },
  );

  const db = app.command('db').description('database info, schema, rows, local proxy, export, import, migrations, snapshots, restore, reset');
  describe(db.command('info').description('connection and size summary (no password)').action(async (_o: unknown, cmd: Command) => info(await make(cmd))), {
    json: '{ status: "ready" | "unknown" | "none", host?, database?, user?, branch?, size_bytes? }',
    exits: [2, 3],
    online: true,
  });
  describe(
    db
      .command('schema [table]')
      .description('tables and columns; with a table also indexes, constraints and a row estimate')
      .action(async (tableName: string | undefined, _o: unknown, cmd: Command) => schema(await make(cmd), tableName)),
    { json: '{ tables: { name, columns: { name, type, nullable, default }[] }[] } | { name, columns, indexes, constraints, row_estimate }', exits: [2, 3, 4], online: true },
  );
  describe(
    db
      .command('rows <table>')
      .description('print rows of a table as a table')
      .option('--where <expr>', 'SQL filter expression')
      .option('--limit <n>', 'max rows', '50')
      .option('--offset <n>', 'skip rows')
      .action(async (tableName: string, opts: { where?: string; limit?: string; offset?: string }, cmd: Command) => rows(await make(cmd), tableName, opts)),
    { json: '{ columns, rows, row_count, elapsed_ms, truncated, limit, offset }', exits: [2, 3, 4], online: true },
  );
  describe(
    db
      .command('proxy')
      .description('a local Postgres port for psql, ORMs and scripts, authenticated with the App key (read-only unless --write); no password is ever shown')
      .option('--port <n>', 'local port (0 = any free port)', '5432')
      .option('--write', 'log in as the database owner (DDL is still refused on main)')
      .action(async (opts: { port?: string; write?: boolean }, cmd: Command) => proxy(await make(cmd), opts)),
    {
      json: 'NDJSON stream: { event: "listening", app, env, host, port, role: "reader" | "owner", database_url }',
      exits: [1, 2, 3, 4],
      online: true,
      examples: ['boxlite-app app db proxy', 'boxlite-app app db proxy --port 15432 --write'],
    },
  );
  describe(
    db
      .command('export')
      .description('download the database: one table as CSV, or schema + data as SQL (streamed)')
      .option('--table <name>', 'one table (required for CSV)')
      .option('--format <fmt>', 'csv | sql (default: csv with --table, else sql)')
      .option('-o, --output <file>', 'write to a file instead of stdout')
      .action(async (opts: { table?: string; format?: string; output?: string }, cmd: Command) => exportDb(await make(cmd), opts)),
    {
      json: '{ file, format: "csv" | "sql", table: string | null, bytes } (needs -o)',
      exits: [1, 2, 3, 4],
      online: true,
      examples: ['boxlite-app app db export --table deals -o deals.csv', 'boxlite-app app db export --format sql -o dump.sql'],
    },
  );
  describe(
    db
      .command('import <file>')
      .description('append the rows of a CSV file (header = column names) to a table, all or nothing; snapshot first')
      .requiredOption('--table <name>', 'the table the rows go into')
      .option('-y, --yes', 'confirm (always required on main)')
      .action(async (file: string, opts: { table: string }, cmd: Command) => importDb(await make(cmd), file, opts)),
    { json: '{ table, rows, columns: string[], snapshot }', exits: [1, 2, 3, 4, 10], destructive: true, online: true, examples: ['boxlite-app app db import deals.csv --table deals --yes'] },
  );
  describe(db.command('migrations').description('applied / pending / changed per migration file (local files vs the database when run in the project)').action(async (_o: unknown, cmd: Command) => migrations(await make(cmd))), {
    json: '{ file, status: "applied" | "pending" | "changed" | "missing_locally", deployment, applied_at }[]',
    exits: [2, 3],
    online: true,
  });
  describe(db.command('diff').description('local migrations vs what the database applied; exit 7 if an applied file was edited').action(async (_o: unknown, cmd: Command) => diff(await make(cmd))), {
    json: '{ file, status: "applied" | "pending" | "changed" | "missing_locally", deployment, applied_at }[]',
    exits: [2, 3, 7],
    online: true,
  });
  describe(
    db
      .command('migration')
      .description('migration files')
      .command('new <name>')
      .description('create the next NNNN_<name>.sql file locally')
      .action(async (name: string, _o: unknown, cmd: Command) => migrationNew(await make(cmd), name)),
    { json: '{ file: string, sha256: string }', online: false },
  );
  describe(
    db
      .command('snapshot')
      .description('take a database snapshot (a named, restorable point in time)')
      .requiredOption('-m, --message <text>', 'what this snapshot is for')
      .action(async (opts: { message?: string }, cmd: Command) => snapshot(await make(cmd), opts)),
    { json: '{ id, message, ts, created_at, by }', exits: [2, 3, 4], online: true },
  );
  describe(db.command('snapshots').description('list snapshots').action(async (_o: unknown, cmd: Command) => snapshots(await make(cmd))), {
    json: '{ id, message, ts, created_at, by }[]',
    exits: [2, 3],
    online: true,
  });
  describe(
    db
      .command('restore')
      .description('restore the database to a point in time or a snapshot (destructive)')
      .option('--to <iso8601>', 'point in time')
      .option('--snapshot <id>', 'snapshot id')
      .option('-y, --yes', 'confirm')
      .action(async (opts: { to?: string; snapshot?: string }, cmd: Command) => restore(await make(cmd), opts)),
    { json: '{ restored_to: string, preserved_as: string }', exits: [2, 3, 4, 10], destructive: true, online: true },
  );
  describe(
    db
      .command('reset')
      .description('drop every table of a non-main environment (snapshot first); migrations re-run on the next apply (destructive)')
      .option('-y, --yes', 'confirm')
      .action(async (_o: unknown, cmd: Command) => reset(await make(cmd))),
    { json: '{ reset: string, dropped_tables: string[], snapshot: string }', exits: [2, 3, 4, 5, 10], destructive: true, online: true },
  );
}
