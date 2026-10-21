import { formatBytes, type CheckResult } from '@microcloud/shared';
import type { Io } from './context.js';

export { formatBytes };

/**
 * All CLI output goes through here. In `--json` mode a command produces exactly one JSON document:
 * `data()` records it and the runner prints it on stdout after the command succeeded; on failure
 * only the `{"error": …}` object is printed, on stderr. `stream()` is the one exception: NDJSON
 * lines for commands that follow (logs --follow).
 */
export class Output {
  private progressActive = false;
  private result: { value: unknown } | null = null;
  private streamed = false;

  constructor(private readonly io: Io, readonly json: boolean) {}

  /** Human-readable line on stdout; suppressed in `--json` mode. */
  line(text = ''): void {
    if (this.json) return;
    this.clearProgress();
    this.io.stdout.write(`${text}\n`);
  }

  /** The command's JSON result (last call wins); printed by `flush()` only if the command succeeds. */
  data(obj: unknown): void {
    if (!this.json) return;
    this.result = { value: obj };
  }

  /** One NDJSON line, written immediately (`--json` only). */
  stream(obj: unknown): void {
    if (!this.json) return;
    this.streamed = true;
    this.io.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  /** Prints the recorded JSON result; called once by the runner after a successful command. */
  flush(): void {
    this.clearProgress();
    if (!this.json || this.streamed || !this.result) return;
    this.io.stdout.write(`${JSON.stringify(this.result.value)}\n`);
  }

  /** Raw text (markdown etc.) regardless of mode. */
  raw(text: string): void {
    this.clearProgress();
    this.io.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  /** `next: <what to do>` as the last human line of a successful command. */
  next(text: string): void {
    this.line(`next: ${text}`);
  }

  note(text: string): void {
    if (this.json) return;
    this.clearProgress();
    this.io.stderr.write(`${text}\n`);
  }

  /** In-place status on a TTY (`\r`), otherwise silent; `line()` or `clearProgress()` ends it. */
  progress(text: string): void {
    if (this.json || !this.io.isTTY) return;
    this.io.stdout.write(`\r\x1b[2K${text}`);
    this.progressActive = true;
  }

  clearProgress(): void {
    if (!this.progressActive) return;
    this.io.stdout.write('\r\x1b[2K');
    this.progressActive = false;
  }
}

export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(none)';
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? v.join(', ') : '(none)';
  return JSON.stringify(v);
}

/** Simple left-aligned table; `rows` are already-formatted strings. */
export function table(rows: string[][], indent = ''): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => indent + row.map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i] ?? 0))).join('  ').trimEnd());
}

export interface PlanChange {
  kind: '+' | '~' | '-' | 'online_only' | string;
  path: string;
  from?: unknown;
  to?: unknown;
}

/**
 * Renders one `/plan` change like the PRD example:
 *   + database        neon branch main, run migrations/0001_init.sql
 *   ~ variables       LOG_LEVEL: (none) → info
 *   ! online only     domains.custom: crm.acme.com   (run `boxlite-app app pull`)
 */
export function formatChange(c: PlanChange): string {
  // File paths (migrations/0001_init.sql) contain dots that are not key separators.
  const [head, ...rest] = c.path.includes('/') ? [c.path] : c.path.split('.');
  const sub = rest.length ? `${rest.join('.')}: ` : '';
  switch (c.kind) {
    case '+':
      return `  + ${pad(head ?? '', Math.max(16, (head ?? '').length + 1))}${sub}${formatValue(c.to)}`;
    case '-':
      return `  - ${pad(head ?? '', Math.max(16, (head ?? '').length + 1))}${sub}${formatValue(c.from)} → (removed)`;
    case '~':
      return `  ~ ${pad(head ?? '', Math.max(16, (head ?? '').length + 1))}${sub}${formatValue(c.from)} → ${formatValue(c.to)}`;
    case 'online_only':
      return `  ! ${pad('online only', 16)}${c.path}: ${formatValue(c.to ?? c.from)}   (run \`boxlite-app app pull\`)`;
    default:
      return `  ${c.kind} ${pad(head ?? '', 16)}${sub}${formatValue(c.to)}`;
  }
}

const STEP_LABELS: Record<string, string> = {
  check: 'Checking',
  database: 'Database',
  box: 'Box',
  upload: 'Uploading',
  build: 'Building',
  migrate: 'Migrating',
  start: 'Starting',
  live: 'Live',
  provision: 'Provisioning',
  rollback: 'Rolling back',
};

export function stepLabel(name: string): string {
  return STEP_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** `#2  Building    npm ci && npm run build   41s` */
export function stepLine(number: number, step: string, detail: string, ms?: number, status?: string): string {
  const parts = [`#${number}`, pad(stepLabel(step), 10), detail].filter((p) => p !== '');
  let line = parts.join('  ').trimEnd();
  if (status === 'failed') line += '   failed';
  const t = formatMs(ms);
  if (t) line += `   ${t}`;
  return line;
}

/** Human lines for `check`: `boxlite.toml:14  unknown_field  message`. */
export function checkLines(result: CheckResult): string[] {
  const lines: string[] = [];
  for (const e of result.errors) lines.push(`${e.file}${e.line !== undefined ? `:${e.line}` : ''}  ${e.rule}  ${e.message}`);
  for (const w of result.warnings) lines.push(`warning  ${w.rule}  ${w.message}`);
  return lines;
}

export function checkSummary(result: CheckResult): string {
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (result.ok && result.warnings.length === 0) return 'ok';
  if (result.ok) return `ok · ${n(result.warnings.length, 'warning')}`;
  return `${n(result.errors.length, 'error')}, ${n(result.warnings.length, 'warning')}`;
}
