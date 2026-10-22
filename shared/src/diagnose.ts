/**
 * Turns a failed deployment (step, message, log tail) into a classified cause with a concrete fix.
 * Shared by the CLI (deploy, doctor, deployment --logs) and the console, so both say the same thing.
 * Every rule looks only at text the platform already produces: supervisor system lines, build
 * output, service stderr and the control plane's step messages.
 */

export type FailureCause =
  | 'missing_lockfile'
  | 'npm_script_missing'
  | 'module_not_found'
  | 'build_timeout'
  | 'build_command_failed'
  | 'port_binding'
  | 'health_404'
  | 'health_failed'
  | 'crash_on_start'
  | 'missing_variable'
  | 'migration_sql_error'
  | 'migration_changed'
  | 'invalid_manifest'
  | 'supervisor_unreachable'
  | 'unknown';

export interface FailureInput {
  step?: string | null;
  message?: string | null;
  log_tail?: readonly string[];
  /** Deployment number, used in the suggested follow-up commands. */
  deployment?: number;
  /** The exposed service as declared in boxlite.toml. */
  service?: { name: string; command?: string; health?: string };
  /** Local migration files, so a SQL error can be pointed at file:line. */
  migrations?: readonly { file: string; sql: string }[];
  /** Migrations directory as declared in boxlite.toml (default `migrations/`). */
  migrationsDir?: string;
  build?: readonly string[];
}

export interface Diagnosis {
  cause: FailureCause;
  /** One line: what went wrong, in the user's terms. */
  summary: string;
  /** What to do next: a file edit or a runnable command. */
  fix: string;
  file?: string;
  line?: number;
  /** The log lines that led to this classification (at most 8). */
  evidence: string[];
}

const MAX_EVIDENCE = 8;

function grab(lines: readonly string[], re: RegExp, max = MAX_EVIDENCE): string[] {
  return lines.filter((l) => re.test(l)).slice(-max);
}

/** Line (1-based) of the first occurrence of `needle` in `sql`, skipping `--` comment lines. */
export function lineOfToken(sql: string, needle: string): number | undefined {
  const lines = sql.split(/\r?\n/);
  const lower = needle.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim().startsWith('--')) continue;
    if (l.toLowerCase().includes(lower)) return i + 1;
  }
  return undefined;
}

/** Line (1-based) of a character offset as reported by Postgres (`position`, 1-based). */
export function lineOfPosition(sql: string, position: number): number {
  return sql.slice(0, Math.max(0, position - 1)).split(/\r?\n/).length;
}

function migrationDiagnosis(input: FailureInput, message: string): Diagnosis | null {
  const dir = input.migrationsDir ?? 'migrations/';
  const changed = /applied migration\(s\) changed: ([^\s,]+)|migration (\S+\.sql) was already applied with different contents/.exec(message);
  if (changed) {
    const file = changed[1] ?? changed[2]!;
    return {
      cause: 'migration_changed',
      summary: `${file} was edited after it was applied`,
      fix: `restore ${dir}${file} to the applied version (\`boxlite-app app clone <app>\` has it), then put the change in a new file: \`boxlite-app app db migration new <name>\``,
      file: `${dir}${file}`,
      evidence: [message],
    };
  }
  const m = /migration (\S+\.sql) failed: (.*)$/s.exec(message);
  if (!m) return null;
  const file = m[1]!;
  const pgMessage = m[2]!.trim();
  const local = input.migrations?.find((f) => f.file === file);
  let line: number | undefined;
  if (local) {
    const position = /position[ :=]+(\d+)/i.exec(pgMessage);
    const near = /at or near "([^"]+)"/.exec(pgMessage);
    const named = /(?:relation|column|table|type|function|constraint|index|schema) "([^"]+)"/.exec(pgMessage);
    if (position) line = lineOfPosition(local.sql, Number(position[1]));
    else if (near) line = lineOfToken(local.sql, near[1]!);
    else if (named) line = lineOfToken(local.sql, named[1]!);
  }
  const where = `${dir}${file}${line !== undefined ? `:${line}` : ''}`;
  return {
    cause: 'migration_sql_error',
    summary: `${where}: ${pgMessage}`,
    fix: `fix the SQL in ${where} (it did not apply, so editing it is safe); to try it first, \`boxlite-app app env create try\` (once), then \`boxlite-app app sql --write --env try --file ${dir}${file}\`; then \`boxlite-app deploy\``,
    file: `${dir}${file}`,
    ...(line !== undefined ? { line } : {}),
    evidence: [message],
  };
}

function buildDiagnosis(input: FailureInput, message: string, tail: readonly string[]): Diagnosis {
  const all = [message, ...tail];
  const text = all.join('\n');
  if (/did not report .* within \d+ s/.test(message)) {
    return {
      cause: 'build_timeout',
      summary: 'the build did not finish within the 20 minute build budget',
      fix: 'make runtime.build faster: drop work that is not needed to start (tests, linting), keep the lockfile so installs are cached, then `boxlite-app deploy`',
      evidence: grab(all, /./, 4),
    };
  }
  if (/npm ci/.test(text) && /(package-lock\.json|npm-shrinkwrap\.json|can only install (packages|with an existing)|EUSAGE)/i.test(text)) {
    return {
      cause: 'missing_lockfile',
      summary: '`npm ci` needs package-lock.json, and the upload has none',
      fix: 'run `npm install` in the project, make sure package-lock.json is not listed in .gitignore or .boxliteignore, then `boxlite-app deploy`',
      file: 'package-lock.json',
      evidence: grab(all, /npm ci|package-lock|shrinkwrap|EUSAGE/i),
    };
  }
  const script = /Missing script: "?([\w:.-]+)"?/i.exec(text);
  if (script) {
    return {
      cause: 'npm_script_missing',
      summary: `package.json has no "${script[1]}" script`,
      fix: `add "${script[1]}" to "scripts" in package.json, or change [runtime].build in boxlite.toml, then \`boxlite-app deploy\``,
      file: 'package.json',
      evidence: grab(all, /Missing script/i),
    };
  }
  const mod = moduleNotFound(all);
  if (mod) return mod;
  const cmd = /build step \d+ \((.*)\) exited with code (\d+)/.exec(message);
  const buildCmd = cmd?.[1] ?? ((input.build ?? []).join(' && ') || 'the build');
  return {
    cause: 'build_command_failed',
    summary: cmd ? `build command \`${cmd[1]}\` exited with code ${cmd[2]}` : message,
    fix: `run \`${buildCmd}\` locally, fix the first error shown in the log lines, then \`boxlite-app deploy\``,
    evidence: grab(tail, /error|ERR!|failed|fatal/i).length ? grab(tail, /error|ERR!|failed|fatal/i) : tail.slice(-MAX_EVIDENCE),
  };
}

function moduleNotFound(lines: readonly string[]): Diagnosis | null {
  for (const l of lines) {
    const node = /Cannot find (?:module|package) '([^']+)'/.exec(l) ?? /ERR_MODULE_NOT_FOUND.*?'([^']+)'/.exec(l);
    if (node) {
      const name = node[1]!;
      const local = name.startsWith('.') || name.startsWith('/');
      return {
        cause: 'module_not_found',
        summary: `module '${name}' cannot be found at runtime`,
        fix: local
          ? `the file '${name}' is not in the upload or not produced by [runtime].build; check the path, .boxliteignore, and that the build writes it, then \`boxlite-app deploy\``
          : `add it to dependencies (not devDependencies): \`npm install ${name}\` so package.json and package-lock.json include it, then \`boxlite-app deploy\``,
        file: local ? undefined : 'package.json',
        evidence: grab(lines, /Cannot find|ERR_MODULE_NOT_FOUND|Require stack/),
      };
    }
    const py = /ModuleNotFoundError: No module named '([^']+)'/.exec(l);
    if (py) {
      return {
        cause: 'module_not_found',
        summary: `Python module '${py[1]}' is not installed`,
        fix: `add ${py[1]} to requirements.txt (or pyproject.toml + lockfile) and make sure [runtime].build installs it, then \`boxlite-app deploy\``,
        file: 'requirements.txt',
        evidence: grab(lines, /ModuleNotFoundError|Traceback/),
      };
    }
  }
  return null;
}

/** "health check for web (http://127.0.0.1:20001/healthz): unhealthy after 1m0s (…, last: HTTP 404)" */
const HEALTH_RE = /health check for ([\w-]+) \(https?:\/\/[^:/]+:(\d+)(\/[^)]*)?\): unhealthy.*last: (.*)\)\s*$/;
const LISTEN_RE = /(?:listen|listening|started|running|server|ready)[^\n]{0,60}?(?:(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0)?:)(\d{2,5})\b/i;
const LOOPBACK_RE = /\b(localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})\b/;

function startDiagnosis(input: FailureInput, message: string, tail: readonly string[]): Diagnosis {
  const all = [message, ...tail];
  const health = tail.map((l) => HEALTH_RE.exec(l)).find((m) => m !== null) ?? null;
  const svcName = health?.[1] ?? /service ([\w-]+)/.exec(message)?.[1] ?? input.service?.name ?? 'web';
  const healthPath = health?.[3] ?? input.service?.health ?? '/';
  const probePort = health?.[2];
  const last = health?.[4] ?? '';

  const mod = moduleNotFound(all);
  if (mod) return mod;

  const exited = all.map((l) => /service ([\w-]+) (?:exited with code (\d+)|failed to start: (.*?);)/.exec(l)).find((m) => m !== null);
  const stderr = errorFocus(tail.filter((l) => l.includes(`[${svcName}]`) || l.startsWith(`${svcName} `)));

  const statusMatch = /HTTP (\d{3})/.exec(last);
  if (statusMatch?.[1] === '404') {
    return {
      cause: 'health_404',
      summary: `${svcName} answers 404 on its health path ${healthPath}`,
      fix: `add a route GET ${healthPath} that returns 200 to ${svcName}, or set health = "<a path that returns 200>" on [[service]] "${svcName}" in boxlite.toml, then \`boxlite-app deploy\``,
      file: 'boxlite.toml',
      evidence: grab(all, /health check|404/),
    };
  }

  // A process that keeps running but never answers: almost always the wrong port or host.
  const refused = /refused|no response|connection reset|EOF|timeout|deadline/i.test(last) || (!statusMatch && health !== null);
  // The supervisor's own lines name 127.0.0.1:<PORT> (its probe target); only app output counts here.
  const appLines = tail.filter((l) => !l.includes('[system]') && !l.includes('health check for'));
  const listen = appLines.map((l) => LISTEN_RE.exec(l)).find((m) => m !== null);
  const loopback = appLines.map((l) => LOOPBACK_RE.exec(l)).find((m) => m !== null);
  if (!exited && (refused || listen)) {
    const wrongPort = listen && probePort && listen[2] !== probePort ? listen[2] : undefined;
    const host = loopback?.[1] ?? (listen?.[1] && listen[1] !== '0.0.0.0' ? listen[1] : undefined);
    const why = wrongPort ? `it listens on port ${wrongPort}, but the platform sets PORT=${probePort}` : host ? `it listens on ${host}, which the platform cannot reach` : `nothing answered on PORT${probePort ? ` (${probePort})` : ''}`;
    return {
      cause: 'port_binding',
      summary: `${svcName} never became reachable: ${why}`,
      fix: `listen on process.env.PORT and host 0.0.0.0 (Node: \`app.listen(Number(process.env.PORT), "0.0.0.0")\`; Python: \`--host 0.0.0.0 --port $PORT\`), never a fixed port or localhost, then \`boxlite-app deploy\``,
      evidence: [...grab(appLines, /listen|localhost|127\.0\.0\.1|PORT/i, 4), ...grab(all, /health check/, 2)],
    };
  }

  const missing = stderr.map((l) => missingVariableIn(l)).find((name) => name !== undefined);
  if (exited && missing) {
    return {
      cause: 'missing_variable',
      summary: `${exited[1]} needs ${missing}, which is not set`,
      fix: variableFix(missing),
      file: 'boxlite.toml',
      evidence: stderr.length ? stderr : grab(all, /exited|error|Error/),
    };
  }

  if (exited) {
    const code = exited[2];
    return {
      cause: 'crash_on_start',
      summary: `${exited[1]} ${code !== undefined ? `exited with code ${code}` : `failed to start: ${exited[3]}`} before it became healthy`,
      fix: `run \`${input.service?.command ?? 'the service command'}\` locally with PORT=3000 (\`boxlite-app app dev\` uses the cloud env), fix the error in its stderr shown above, then \`boxlite-app deploy\``,
      evidence: stderr.length ? stderr : grab(all, /exited|error|Error/),
    };
  }

  if (statusMatch) {
    return {
      cause: 'health_failed',
      summary: `${svcName} answers HTTP ${statusMatch[1]} on ${healthPath}; the platform needs 2xx within 60 s`,
      fix: `make GET ${healthPath} return 200 quickly without calling the database or other services, then \`boxlite-app deploy\``,
      evidence: [...grab(all, /health check/, 2), ...stderr.slice(-4)],
    };
  }
  return unknownDiagnosis(input, message, tail);
}

/** A line that starts an error report: `Error: …`, `TypeError: …`, `npm ERR!`, `panic: …`, `fatal: …`. */
const ERROR_LINE_RE = /^(?:Uncaught )?(?:[A-Z]\w*)?Error\b|^\w+(?:Error|Exception)\b:|\bERR!|^panic:|^fatal:/;

/**
 * Up to `max` lines starting at the last error line, so evidence leads with what broke instead of
 * the end of a stack trace (`at …`, `}`, `Node.js v22`). Without an error line, the last `max`.
 * Lines may carry a `<ts> [source] ` prefix.
 */
export function errorFocus(lines: readonly string[], max = MAX_EVIDENCE): string[] {
  const text = (l: string) => l.replace(/^\S+Z /, '').replace(/^\[[\w-]+\] /, '').trim();
  let at = -1;
  lines.forEach((l, i) => {
    if (ERROR_LINE_RE.test(text(l))) at = i;
  });
  return at < 0 ? lines.slice(-max) : lines.slice(at, at + max);
}

/** The environment variable a service says it lacks: `Error: SLACK_TOKEN is not set` → SLACK_TOKEN. */
export function missingVariableIn(text: string): string | undefined {
  const m =
    /\b([A-Z][A-Z0-9_]{1,63}) (?:is not set|is not defined|is missing|is required|must be set|not set)\b/.exec(text) ??
    /\b(?:missing|required) (?:environment )?(?:variable|env var|env)[: ]+([A-Z][A-Z0-9_]{1,63})\b/i.exec(text);
  return m?.[1];
}

const CREDENTIAL_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASS|CREDENTIALS?|DSN|WEBHOOK)(_|$)/;

/** A variable name that holds a credential by convention (…_TOKEN, …_KEY, …_SECRET, …). */
export function looksLikeCredential(name: string): boolean {
  return CREDENTIAL_RE.test(name);
}

/** How to keep credential `name` in the org's secret store and reference it: the steps an agent can take. */
export function secretRefFix(name: string): string {
  const ref = `org/${name.toLowerCase().replace(/_/g, '-')}`;
  return `ask the user for it to be stored as the org secret ${ref} (or the name they already use), then \`boxlite-app app secrets ref ${name} ${ref}\` and \`boxlite-app deploy\`; never invent its value or write it into a file`;
}

/** How to give a service the variable it lacks: a credential comes from the org's secret store, anything else is a plain variable. */
function variableFix(name: string): string {
  if (looksLikeCredential(name)) return `${name} is a credential: ${secretRefFix(name)}`;
  return `\`boxlite-app app vars set ${name}=<value>\` with the value the app expects (ask the user if you do not know it), then \`boxlite-app deploy\``;
}

function unknownDiagnosis(input: FailureInput, message: string, tail: readonly string[]): Diagnosis {
  return {
    cause: 'unknown',
    summary: message || 'the deployment failed',
    fix: `read the full timeline with \`boxlite-app app deployment ${input.deployment ?? '<N>'} --logs\`, fix the first error, then \`boxlite-app deploy\``,
    evidence: grab(tail, /error|failed|fatal|ERR/i).length ? grab(tail, /error|failed|fatal|ERR/i) : tail.slice(-MAX_EVIDENCE),
  };
}

export function classifyFailure(input: FailureInput): Diagnosis {
  const message = (input.message ?? '').trim();
  const tail = input.log_tail ?? [];
  const step = input.step ?? '';

  const migration = migrationDiagnosis(input, message);
  if (migration) return migration;

  if (step === 'check' || /problem\(s\) in boxlite\.toml|check failed/.test(message)) {
    return { cause: 'invalid_manifest', summary: message, fix: 'run `boxlite-app check`, fix every error it lists, then `boxlite-app deploy`', file: 'boxlite.toml', evidence: [message] };
  }
  if (/supervisor .* did not answer|has no Box yet|no longer exists/.test(message)) {
    return {
      cause: 'supervisor_unreachable',
      summary: message,
      fix: 'run `boxlite-app app logs --source system --since 30m` to see the Box boot, then `boxlite-app deploy` again; if it repeats, `boxlite-app doctor`',
      evidence: grab(tail, /./, 4),
    };
  }
  if (step === 'build' || /^build step/.test(message)) return buildDiagnosis(input, message, tail);
  if (step === 'start' || step === 'live' || /health check|services did not become healthy/.test(message)) return startDiagnosis(input, message, tail);
  const mod = moduleNotFound([message, ...tail]);
  if (mod) return mod;
  return unknownDiagnosis(input, message, tail);
}
