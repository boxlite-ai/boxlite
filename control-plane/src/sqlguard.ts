/**
 * Classifies SQL sent to POST /db/sql (and the table browser's `where`) before it reaches the app
 * database. It parses with libpg-query, the real PostgreSQL 17 grammar compiled to wasm, so
 * quoting, dollar quotes, nested comments, E'' strings and quoted identifiers are handled exactly
 * as Postgres handles them. Neon runs Postgres 17 too.
 *
 * Layers:
 *  1. This classifier. It refuses statements that would escape the wrapping transaction or the
 *     reader role (transaction control, SET ROLE/RESET ROLE/SESSION AUTHORIZATION, set_config(),
 *     UPDATE pg_settings, RESET ALL, DISCARD), statements that reach the server's files, programs
 *     or network (COPY … PROGRAM/file, LOAD, dblink, lo_import, pg_read_file, …), statements that
 *     signal or stall other sessions (pg_terminate_backend, pg_sleep, …), and platform-level
 *     changes (ALTER SYSTEM, CREATE EXTENSION, roles, databases). It marks DDL-class statements
 *     (any CREATE/ALTER/DROP…, DO, CALL, COPY, GRANT…; SECURITY DEFINER functions) so the route
 *     can refuse them on main and require write:true elsewhere. Unknown statement types are
 *     DDL-class: it fails closed.
 *  2. appdb.ts runs reads logged in as `boxlite_reader` (dbreader.ts) inside `BEGIN TRANSACTION
 *     READ ONLY`, with statement and idle-in-transaction timeouts. On Neon that role is a member of
 *     neon_superuser (API-created roles always are), so this guard is what keeps a read from
 *     signalling other sessions or reaching files and the network; role SQL is refused here as
 *     defence in depth (the session is the reader, so it cannot reach the owner anyway).
 *  3. pg's extended protocol accepts one command per message, so nothing can be smuggled past
 *     this split.
 */
import { loadModule, parseSync } from 'libpg-query';

await loadModule();

export const READER_ROLE = 'boxlite_reader';

export type StatementKind = 'read' | 'write' | 'ddl';

export interface Statement {
  /** Original text of this statement (comments kept), without the trailing semicolon. */
  text: string;
  /** First keyword, upper-cased (for EXPLAIN: `EXPLAIN`). For messages and the activity log. */
  keyword: string;
  /** read: no writes; write: DML (needs write:true, Postgres enforces); ddl: schema/platform changes. */
  kind: StatementKind;
  ddl: boolean;
}

export interface Classification {
  statements: Statement[];
  ddl: boolean;
  /** Reason the query must be refused regardless of flags, or null. */
  refused: string | null;
  /** Set when the text does not parse; the route answers sql_error like Postgres would. */
  syntaxError?: { message: string; position: number };
}

type Node = Record<string, unknown>;

/** Settings that would change who runs the query, or lift the transaction's guard rails. */
const DENIED_SETTINGS = new Set([
  'role',
  'session_authorization',
  'statement_timeout',
  'idle_in_transaction_session_timeout',
  'transaction_timeout',
  'lock_timeout',
  'default_transaction_read_only',
  'default_transaction_isolation',
  'default_transaction_deferrable',
  'session_replication_role',
  'session characteristics',
]);

/** Functions refused anywhere in a statement tree (matched on the unqualified, lower-cased name). */
const DENIED_FUNCTIONS = new Set([
  // Changes settings (role!) exactly like SET; `set_config('role', 'neondb_owner', true)` escalates.
  'set_config',
  // Signal or stall other sessions.
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_sleep',
  'pg_sleep_for',
  'pg_sleep_until',
  // Server administration.
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_promote',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_stat_file',
  'pg_notify',
  'pg_import_system_collations',
  // Run a query given as text, which this classifier cannot see.
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'ts_stat',
]);

/** Function name prefixes refused anywhere: server files, large objects, outbound connections, replication. */
const DENIED_FUNCTION_PREFIXES = ['dblink', 'lo_', 'pg_read_', 'pg_ls_', 'pg_file_', 'pg_logical_', 'pg_replication_', 'pg_create_', 'pg_drop_replication', 'pg_copy_', 'pg_log_', 'pg_stat_reset'];

/** Statement types that are refused outright through the SQL endpoint, with the reason. */
const REFUSED_STATEMENTS: Record<string, string> = {
  TransactionStmt: 'is not allowed: every query already runs in its own transaction',
  DiscardStmt: 'is not allowed: it would reset the session the query runs in',
  ListenStmt: 'is not supported through the SQL endpoint',
  UnlistenStmt: 'is not supported through the SQL endpoint',
  NotifyStmt: 'is not supported through the SQL endpoint',
  PrepareStmt: 'is not supported through the SQL endpoint (send the statement itself)',
  ExecuteStmt: 'is not supported through the SQL endpoint (send the statement itself)',
  DeallocateStmt: 'is not supported through the SQL endpoint',
  LoadStmt: 'is not allowed: it loads a shared library into the server',
  CheckPointStmt: 'is not allowed',
  AlterSystemStmt: 'is not allowed: server configuration is managed by the platform',
  CreateExtensionStmt: 'is not allowed through SQL: add `CREATE EXTENSION IF NOT EXISTS …` to a migration',
  AlterExtensionStmt: 'is not allowed through SQL: change extensions in a migration',
  AlterExtensionContentsStmt: 'is not allowed through SQL: change extensions in a migration',
  CreateRoleStmt: 'is not allowed: database roles are managed by the platform',
  AlterRoleStmt: 'is not allowed: database roles are managed by the platform',
  AlterRoleSetStmt: 'is not allowed: database roles are managed by the platform',
  DropRoleStmt: 'is not allowed: database roles are managed by the platform',
  GrantRoleStmt: 'is not allowed: database roles are managed by the platform',
  DropOwnedStmt: 'is not allowed: database roles are managed by the platform',
  ReassignOwnedStmt: 'is not allowed: database roles are managed by the platform',
  CreatedbStmt: 'is not allowed: databases are managed by the platform',
  DropdbStmt: 'is not allowed: databases are managed by the platform',
  AlterDatabaseStmt: 'is not allowed: databases are managed by the platform',
  AlterDatabaseSetStmt: 'is not allowed: databases are managed by the platform',
  AlterDatabaseRefreshCollStmt: 'is not allowed: databases are managed by the platform',
};

/** Statement types that only read (their trees are still walked for denied functions). */
const READ_STATEMENTS = new Set(['SelectStmt', 'VariableShowStmt', 'VariableSetStmt', 'DeclareCursorStmt', 'FetchStmt', 'ClosePortalStmt']);
// LOCK is not here on purpose: Postgres allows LOCK TABLE (any mode) in a READ ONLY transaction,
// and the reader can take ACCESS EXCLUSIVE on Neon, so a "read" could stall the app. It is DDL-class.
const WRITE_STATEMENTS = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);
const DML_NODES = new Set(['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt']);

/** Inside DO bodies and function bodies (opaque strings to the SQL parser): the same escapes, by text. */
const BODY_DENIED = new RegExp(
  [
    String.raw`\b(?:${[...DENIED_FUNCTIONS].filter((f) => f !== 'set_config').join('|')})\s*\(`,
    String.raw`\b(?:${DENIED_FUNCTION_PREFIXES.join('|')})\w*\s*\(`,
    String.raw`\bset_config\s*\(\s*'(?:role|session_authorization)'`,
    String.raw`\b(?:set|reset)\s+(?:local\s+|session\s+)?role\b`,
    String.raw`\bsession\s+authorization\b`,
    String.raw`\bcopy\b[^;]*\b(?:program|from\s+'|to\s+')`,
  ].join('|'),
  'i',
);

function nodeType(n: Node): [string, Node] {
  const [type, data] = Object.entries(n)[0] as [string, Node];
  return [type, data ?? {}];
}

/** Every `{Type: data}` object in the tree, depth first. */
function* walk(value: unknown): Generator<[string, Node]> {
  if (Array.isArray(value)) {
    for (const v of value) yield* walk(v);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Node)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && /^[A-Z]/.test(k)) yield [k, v as Node];
    yield* walk(v);
  }
}

function strings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((x) => ((x as { String?: { sval?: string } }).String?.sval ?? '')).filter(Boolean);
}

function deniedFunction(name: string): boolean {
  const n = name.toLowerCase();
  return DENIED_FUNCTIONS.has(n) || DENIED_FUNCTION_PREFIXES.some((p) => n.startsWith(p));
}

/** DO $$…$$ and CREATE FUNCTION … AS '…' bodies. */
function bodies(type: string, data: Node): string[] {
  const out: string[] = [];
  const defs = type === 'DoStmt' ? data.args : data.options;
  if (!Array.isArray(defs)) return out;
  for (const d of defs) {
    const def = (d as { DefElem?: { defname?: string; arg?: Node } }).DefElem;
    if (def?.defname !== 'as' || !def.arg) continue;
    const arg = def.arg as { String?: { sval?: string }; List?: { items?: unknown[] } };
    if (arg.String?.sval) out.push(arg.String.sval);
    out.push(...strings(arg.List?.items));
  }
  return out;
}

function securityDefiner(type: string, data: Node): boolean {
  if (type !== 'CreateFunctionStmt' && type !== 'AlterFunctionStmt') return false;
  const defs = (type === 'CreateFunctionStmt' ? data.options : data.actions) as unknown[] | undefined;
  return (defs ?? []).some((d) => {
    const def = (d as { DefElem?: { defname?: string; arg?: { Boolean?: { boolval?: boolean } } } }).DefElem;
    return def?.defname === 'security' && def.arg?.Boolean?.boolval === true;
  });
}

/** Leading keyword of a statement's text, skipping comments and parentheses. */
function firstKeyword(text: string): string {
  let s = text;
  for (;;) {
    const before = s;
    s = s.replace(/^[\s(]+/, '').replace(/^--[^\n]*/, '');
    if (s.startsWith('/*')) {
      let depth = 0;
      let i = 0;
      for (; i < s.length; i++) {
        if (s.startsWith('/*', i)) {
          depth++;
          i++;
        } else if (s.startsWith('*/', i)) {
          depth--;
          i++;
          if (depth === 0) break;
        }
      }
      s = s.slice(i + 1);
    }
    if (s === before) break;
  }
  return (/^[A-Za-z]+/.exec(s)?.[0] ?? '').toUpperCase();
}

/** Why one parsed statement must be refused, or null. */
function refusal(type: string, data: Node, keyword: string): string | null {
  const reason = REFUSED_STATEMENTS[type];
  if (reason) return `${keyword} ${reason}`;
  if (type === 'VariableSetStmt') {
    if (data.kind === 'VAR_RESET_ALL') return 'RESET ALL is not allowed: it would lift the guard rails the query runs under';
    const name = String(data.name ?? '').toLowerCase();
    if (DENIED_SETTINGS.has(name) || name.startsWith('transaction')) return `${keyword} ${name} is not allowed`;
  }
  if (type === 'CopyStmt') {
    if (data.is_program || data.filename) return 'COPY to or from a server file or program is never allowed';
    return 'COPY is not supported through the SQL endpoint: use SELECT to read and INSERT to write';
  }
  for (const [t, d] of [[type, data] as [string, Node], ...walk(data)]) {
    if (t === 'FuncCall') {
      const name = strings(d.funcname).at(-1) ?? '';
      if (deniedFunction(name)) return `function ${name}() is not allowed through the SQL endpoint`;
    }
    if (DML_NODES.has(t)) {
      const rel = d.relation as { relname?: string; schemaname?: string } | undefined;
      if (rel && (rel.relname?.toLowerCase() === 'pg_settings' || rel.schemaname === 'pg_catalog' || rel.schemaname === 'information_schema')) {
        return `writing to ${rel.schemaname ? `${rel.schemaname}.` : ''}${rel.relname} is not allowed`;
      }
    }
  }
  if (type === 'DoStmt' || type === 'CreateFunctionStmt') {
    for (const body of bodies(type, data)) {
      const m = BODY_DENIED.exec(body);
      if (m) return `${keyword} body uses ${m[0].replace(/\s*\($/, '()').trim()}, which is not allowed through the SQL endpoint`;
    }
  }
  return null;
}

function kindOf(type: string, data: Node): StatementKind {
  if (type === 'ExplainStmt') {
    const analyze = (data.options as unknown[] | undefined)?.some((o) => (o as { DefElem?: { defname?: string } }).DefElem?.defname === 'analyze');
    if (!analyze) return 'read';
    const [t, d] = nodeType(data.query as Node);
    return kindOf(t, d);
  }
  if (type === 'SelectStmt' && data.intoClause) return 'ddl';
  if (READ_STATEMENTS.has(type) || WRITE_STATEMENTS.has(type)) {
    for (const [t] of walk(data)) if (DML_NODES.has(t)) return 'write';
    return WRITE_STATEMENTS.has(type) ? 'write' : 'read';
  }
  // CREATE/ALTER/DROP/RENAME/COMMENT/GRANT/TRUNCATE/REINDEX/CLUSTER/VACUUM/REFRESH, DO, CALL,
  // COPY, SECURITY LABEL, IMPORT FOREIGN SCHEMA, … and anything this list does not know.
  return 'ddl';
}

/** Byte offsets (what libpg_query reports) → string slice. */
function sliceBytes(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString('utf8');
}

export function classify(sql: string): Classification {
  if (!sql.trim()) return { statements: [], ddl: false, refused: 'empty query' };
  let parsed: { stmts?: { stmt: Node; stmt_location?: number; stmt_len?: number }[] };
  try {
    parsed = parseSync(sql) as typeof parsed;
  } catch (err) {
    const e = err as { message?: string; sqlDetails?: { cursorPosition?: number } };
    // libpg-query reports a 0-based character offset; Postgres reports 1-based.
    const position = (e.sqlDetails?.cursorPosition ?? 0) + 1;
    return { statements: [], ddl: false, refused: null, syntaxError: { message: e.message ?? 'syntax error', position } };
  }
  const buf = Buffer.from(sql, 'utf8');
  const statements: Statement[] = [];
  let refused: string | null = null;
  for (const s of parsed.stmts ?? []) {
    const start = s.stmt_location ?? 0;
    const text = sliceBytes(buf, start, s.stmt_len ? start + s.stmt_len : buf.length).trim();
    const [type, data] = nodeType(s.stmt);
    const keyword = firstKeyword(text) || type.replace(/Stmt$/, '').toUpperCase();
    let kind = kindOf(type, data);
    if (securityDefiner(type, data)) kind = 'ddl';
    statements.push({ text, keyword, kind, ddl: kind === 'ddl' });
    refused ??= refusal(type, data, keyword);
  }
  if (statements.length === 0) refused ??= 'empty query';
  return { statements, ddl: statements.some((s) => s.ddl), refused };
}
