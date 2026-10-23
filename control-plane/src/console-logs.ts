/**
 * The console's reading of an env's log lines (the Logs tab). Stored lines stay exactly as their
 * writers sent them, so the CLI and `logs/search` see every detail; this only decides how the
 * console presents them:
 *
 *   - a deployment's milestones (live, failed, cancelled, migrations applied) become one short line
 *     each under source `deploy` (`#3 is live · by key …4swr in 2.6 s`, `2 migrations applied: …`);
 *   - platform chatter (supervisor boot, spec fetches, snapshot paths, gateway switches), build
 *     output and visitor requests are `detail`: the console shows them only when their source is
 *     picked, while warnings and errors (other than requests) stay in the default view;
 *   - levels are corrected where the writer's level misleads: build tools print progress on stderr
 *     (`npm notice` is not an error, `npm warn … not found` is a warning read with the build), and a service stopped by SIGTERM (exit 143) during a planned
 *     stop, sleep or redeploy is not a crash.
 */
import { actorLabel } from './console-activity.js';
import type { Deployment } from './db.js';
import { logLevel, type LogLevel } from './services/logs.js';

export interface ConsoleLogLine {
  id: string;
  ts: string;
  source: string;
  level: LogLevel;
  line: string;
  deployment: number | null;
  /** Shown only when its source is picked. Platform warnings and errors are never detail; requests always are. */
  detail: boolean;
}

export interface RawLogLine {
  id: string;
  ts: string;
  source: string;
  level: string;
  line: string;
  deployment: number | null;
}

/** Sources the console always shows by default; anything else from the platform is detail. */
const PLATFORM_DETAIL = new Set(['system', 'build', 'access']);

const LIVE_RE = /^deployment #(\d+) is live at /;
const FAILED_RE = /^deployment #(\d+) failed at step ([\w-]+): (.*?)(?: \(previous release stays live\))?$/;
const APPLYING_RE = /^applying migration (\S+)/;
const APPLIED_RE = /^applied (\d+) migration\(s\)/;
const SIGTERM_EXIT_RE = /^service (\S+) (?:exited with code 143|stopped \(exit code 143\))/;
/** A build tool's own warning marker (`npm warn`, `warning:`, `[WARN]`), checked before the error words it may contain. */
const BUILD_WARN_RE = /^\s*(?:npm warn\b|warn(?:ing)?\b[:\s]|\[warn(?:ing)?\])/i;
/** A build line on stderr is an error only when it says so. */
const BUILD_ERROR_RE = /\b(error|failed|fatal|exception|cannot find|not found)\b|\bERR!/i;

/**
 * What a build line on stderr really is: build tools print progress and notices there. A warning
 * marker wins over the error words it may contain (`npm warn … not found`). The console's logs
 * and the agent's recent errors (agent-context.ts) both read build lines through this.
 */
export function buildLineLevel(line: string): 'error' | 'warn' | 'info' {
  if (BUILD_WARN_RE.test(line)) return 'warn';
  return BUILD_ERROR_RE.test(line) ? 'error' : 'info';
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** `#3 is live · by key …4swr in 2.6 s` from the deployment's own record. */
function liveLine(n: number, d: Deployment | undefined): string {
  if (!d) return `#${n} is live`;
  const took = d.started_at && d.live_at ? Date.parse(d.live_at) - Date.parse(d.started_at) : null;
  const what = d.kind === 'rollback' ? 'rolled back and live' : d.kind === 'apply' ? 'live with new configuration' : 'live';
  return `#${n} is ${what} · by ${actorLabel(d.by)}${took !== null && took >= 0 ? ` in ${seconds(took)}` : ''}`;
}

/**
 * Presents stored lines (any order) for the console, newest first. `deployments` looks up the
 * record a milestone names.
 */
export function presentLogLines(lines: RawLogLine[], deployment: (n: number) => Deployment | undefined): ConsoleLogLine[] {
  const oldestFirst = [...lines].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const applying = new Map<number | null, string[]>();
  const out: ConsoleLogLine[] = [];
  for (const l of oldestFirst) {
    let level = logLevel(l.level);
    let source = l.source;
    let line = l.line;
    let detail = PLATFORM_DETAIL.has(l.source);

    if (l.source === 'system') {
      let m: RegExpExecArray | null;
      if ((m = LIVE_RE.exec(l.line))) {
        source = 'deploy';
        line = liveLine(Number(m[1]), deployment(Number(m[1])));
        detail = false;
      } else if ((m = FAILED_RE.exec(l.line))) {
        source = 'deploy';
        line = `#${m[1]} failed at ${m[2]}: ${m[3]}`;
        level = 'error';
        detail = false;
      } else if (l.line === 'cancelled' && l.deployment) {
        source = 'deploy';
        line = `#${l.deployment} cancelled`;
        detail = false;
      } else if ((m = APPLYING_RE.exec(l.line))) {
        applying.set(l.deployment, [...(applying.get(l.deployment) ?? []), m[1]!]);
      } else if ((m = APPLIED_RE.exec(l.line))) {
        const files = applying.get(l.deployment) ?? [];
        applying.delete(l.deployment);
        const count = Number(m[1]);
        source = 'db';
        line = `${count} migration${count === 1 ? '' : 's'} applied${files.length ? `: ${files.join(', ')}` : ''}${l.deployment ? ` (#${l.deployment})` : ''}`;
        detail = false;
      } else if (/^failed at [\w-]+: /.test(l.line)) {
        // The orchestrator's own copy of the failure; the deploy line above says it once.
        detail = true;
        level = 'info';
      } else if (SIGTERM_EXIT_RE.test(l.line)) {
        // SIGTERM comes from a planned stop (sleep, redeploy, restart), not from the app failing.
        level = 'info';
      }
    } else if (l.source === 'build' && level === 'error') {
      level = buildLineLevel(l.line);
    }

    // Warnings and errors of the platform stay in view, except a build tool's warnings (read with
    // the build output); visitor requests are counted on the Overview and listed only under their
    // own source.
    const stayInView = level === 'error' || (level === 'warn' && source !== 'build');
    if (detail && stayInView && source !== 'access') detail = false;
    out.push({ id: l.id, ts: l.ts, source, level, line, deployment: l.deployment, detail });
  }
  return out.reverse();
}
