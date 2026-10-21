import { MicrocloudError } from '@microcloud/shared';
import type { Command } from 'commander';
import { eventData, type LogLine } from '../api.js';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { abortOnSigint } from '../follow.js';
import { describe } from '../meta.js';
import { pad } from '../output.js';
import { parseInteger } from './common.js';

export interface LogsOptions {
  source?: string;
  level?: string;
  since?: string;
  until?: string;
  grep?: string;
  deployment?: string;
  limit?: string;
  follow?: boolean;
}

const LEVELS: Record<string, string[]> = { error: ['error'], warn: ['warn', 'warning', 'error'], info: [] };
/** With --grep the CLI filters locally, so it asks for the widest window the CP serves. */
const GREP_WINDOW = 5000;

function compileGrep(pattern: string | undefined): RegExp | null {
  if (pattern === undefined) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (e) {
    throw new MicrocloudError('usage', `--grep is not a valid regular expression: ${(e as Error).message}`, 'escape special characters, e.g. --grep "GET /api\\\\?"');
  }
}

export function formatLogLine(l: Pick<LogLine, 'ts' | 'source' | 'level' | 'line'>): string {
  return `${l.ts ?? ''}  ${pad(l.source ?? '', 7)} ${l.level === 'error' ? '! ' : ''}${l.line}`.trimStart();
}

async function logs(ctx: Ctx, opts: LogsOptions): Promise<void> {
  if (opts.level !== undefined && !(opts.level in LEVELS)) throw new MicrocloudError('usage', `--level must be error, warn or info (got "${opts.level}")`, '`boxlite-app app logs --level error`');
  const grep = compileGrep(opts.grep);
  const limit = opts.limit !== undefined ? parseInteger(opts.limit, '--limit') : 200;
  const deployment = opts.deployment !== undefined ? parseInteger(opts.deployment, '--deployment') : undefined;
  const levels = LEVELS[opts.level ?? 'info'] ?? [];
  const keep = (l: Pick<LogLine, 'level' | 'line' | 'deployment'>): boolean =>
    (levels.length === 0 || levels.includes(l.level)) && (!grep || grep.test(l.line)) && (deployment === undefined || l.deployment === deployment);
  const api = await ctx.appApi();

  if (!opts.follow) {
    // The plain endpoint covers source/since/limit; level, deployment, until and grep need the search endpoint.
    const lines: LogLine[] =
      opts.level || deployment !== undefined || opts.until || grep
        ? await api.searchLogs({ source: opts.source, level: opts.level, since: opts.since, until: opts.until, deployment, limit: grep ? GREP_WINDOW : limit })
        : ((await api.getLogs({ source: opts.source, since: opts.since, limit: opts.limit !== undefined ? limit : undefined })) as LogLine[]);
    const shown = lines.filter(keep).slice(-limit);
    ctx.out.data(shown);
    for (const l of shown) ctx.out.line(formatLogLine(l));
    if (!shown.length) {
      ctx.out.line('no matching log lines');
      ctx.out.next(opts.since || opts.level || grep ? 'widen the window (`--since 24h`) or drop --level/--grep' : 'nothing logged yet; `boxlite-app app services` shows whether the app is running');
    }
    return;
  }

  const { signal, dispose } = abortOnSigint();
  try {
    for await (const ev of api.followLogs({ source: opts.source, since: opts.since, limit: opts.limit !== undefined ? limit : undefined }, signal)) {
      if (ev.event !== 'log') continue;
      const log = eventData<LogLine>(ev);
      if (!log || !keep(log)) continue;
      ctx.out.stream(log);
      ctx.out.line(formatLogLine(log));
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  } finally {
    dispose();
  }
}

export function registerLogs(app: Command, make: MakeCtx): void {
  describe(
    app
      .command('logs')
      .description('service, build, schedule and system logs, filtered')
      .option('--source <name>', 'a service name, or build | system | schedule')
      .option('--level <level>', 'error (stderr and failures) | warn (warnings and errors) | info (everything)')
      .option('--since <when>', 'duration back from now (90s, 10m, 2h, 2d) or an ISO timestamp')
      .option('--until <when>', 'end of the window, same formats as --since')
      .option('--grep <regex>', 'only lines matching this regular expression (case-insensitive)')
      .option('--deployment <n>', 'only lines of deployment N')
      .option('--limit <n>', 'max lines (default 200)')
      .option('--follow', 'stream new lines until Ctrl-C (NDJSON with --json)')
      .action(async (opts: LogsOptions, cmd: Command) => logs(await make(cmd), opts)),
    {
      json: '{ id, ts, source, level, line, deployment }[] (oldest first); with --follow one such object per line (NDJSON)',
      exits: [2, 3],
      online: true,
      examples: ['boxlite-app app logs --source web --level error --since 10m', 'boxlite-app app logs --grep "timeout|ECONN" --since 2h', 'boxlite-app app logs --deployment 7', 'boxlite-app app logs --follow --json'],
    },
  );
}
