import { classifyFailure } from './diagnose.js';

/**
 * Everything an agent needs about one environment, as returned by
 * `GET /v1/apps/{app}/envs/{env}/context` and printed by `boxlite-app app context`.
 * Secret values never appear: variables that come from `[secrets]` carry `value: null`.
 */
export interface AgentContext {
  app: string;
  env: string;
  control_plane: string;
  generated_at: string;
  /** new | deploying | live | live (last deployment failed) | failed */
  status: string;
  urls: { app: string; health: string | null; login: string | null };
  access: { level: string; source: 'manifest' | 'online' };
  environments: { name: string; status: string; url: string }[];
  live: { deployment: number; spec_version: number | null; live_at: string | null } | null;
  box: { id: string; state: string } | null;
  runtime: { image: string; size: string; build: string[] } | null;
  services: AgentService[];
  schedules: AgentSchedule[];
  database: AgentDatabase | null;
  volumes: { name: string; mount: string; mode: string }[];
  auth: { enabled: boolean; providers: { name: string; status: string }[]; protect: string[]; login_url: string; users: number };
  variables: AgentVariable[];
  /** Newest first, at most 5. */
  deployments: AgentDeployment[];
  /** Newest last: error-level lines of the last 24 h, at most 20. */
  recent_errors: { ts: string; source: string; line: string; deployment: number | null }[];
  /** Ranked problems with fixes, worst first; empty when everything looks fine. */
  next_actions: Finding[];
  cli: { latest_version: string | null };
}

export interface AgentService {
  name: string;
  exposed: boolean;
  command: string | null;
  static: string | null;
  health_path: string | null;
  /** From the supervisor; null before the first deploy. */
  state: string | null;
  health: string | null;
  restarts: number | null;
  last_exit_code: number | null;
}

export interface AgentSchedule {
  name: string;
  cron: string;
  target: string;
  next_run: string | null;
  last_run: string | null;
  last_status: number | null;
}

export interface AgentDatabase {
  status: 'ready' | 'unreachable' | 'not_provisioned';
  branch: string | null;
  error?: string;
  tables: { name: string; columns: { name: string; type: string; nullable: boolean; default: string | null }[] }[];
  migrations: { file: string; status: 'applied' | 'pending' | 'changed'; deployment: number | null; applied_at: string | null }[];
}

export interface AgentVariable {
  name: string;
  /** null for secrets and for platform values that are themselves credentials (DATABASE_URL). */
  value: string | null;
  secret: boolean;
  /** `boxlite.toml`, `secret org/openai`, or `platform`. */
  source: string;
  /** False when a `[secrets]` reference names an org secret that does not exist. */
  resolved: boolean;
}

export interface AgentDeployment {
  number: number;
  kind: string;
  status: string;
  message: string | null;
  created_at: string;
  finished_at: string | null;
  spec_version: number | null;
  error: { step: string; message: string; log_tail?: string[] } | null;
}

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  /** Stable id, e.g. `deploy_failed`, `crash_loop`, `auth_not_ready`. */
  id: string;
  severity: Severity;
  title: string;
  /** A concrete command or file edit. */
  fix: string;
  detail?: string;
  evidence?: string[];
}

const RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function rankFindings(findings: Finding[]): Finding[] {
  return findings.map((f, i) => ({ f, i })).sort((a, b) => RANK[a.f.severity] - RANK[b.f.severity] || a.i - b.i).map((x) => x.f);
}

/** Restarts above this count mean the service is crash-looping rather than recovering. */
export const CRASH_LOOP_RESTARTS = 3;

/** Problems visible from the control plane's side of one environment. */
export function contextFindings(c: Omit<AgentContext, 'next_actions'>): Finding[] {
  const out: Finding[] = [];
  const latest = c.deployments[0];
  const exposed = c.services.find((s) => s.exposed);

  if (!latest) {
    out.push({ id: 'not_deployed', severity: 'info', title: `${c.env} has never been deployed`, fix: 'run `boxlite-app check`, then `boxlite-app deploy -m "first version"`' });
  } else if (latest.status === 'failed' && latest.error) {
    const d = classifyFailure({ step: latest.error.step, message: latest.error.message, log_tail: latest.error.log_tail, deployment: latest.number, service: exposed ? { name: exposed.name, command: exposed.command ?? undefined, health: exposed.health_path ?? undefined } : undefined });
    out.push({
      id: 'deploy_failed',
      severity: 'error',
      title: `deployment #${latest.number} failed at ${latest.error.step}: ${d.summary}`,
      fix: d.fix,
      detail: c.live ? `#${c.live.deployment} is still serving` : 'nothing is serving yet',
      evidence: d.evidence,
    });
  } else if (['queued', 'uploading', 'building', 'migrating', 'starting'].includes(latest.status)) {
    out.push({ id: 'deploy_in_progress', severity: 'info', title: `deployment #${latest.number} is ${latest.status}`, fix: `follow it: \`boxlite-app app deployment ${latest.number} --follow\`` });
  }

  for (const s of c.services) {
    const errs = c.recent_errors.filter((e) => e.source === s.name).slice(-5).map((e) => e.line);
    if ((s.restarts ?? 0) > CRASH_LOOP_RESTARTS) {
      out.push({
        id: 'crash_loop',
        severity: 'error',
        title: `service ${s.name} restarted ${s.restarts} times${s.last_exit_code != null ? ` (last exit code ${s.last_exit_code})` : ''}`,
        fix: `read its stderr: \`boxlite-app app logs --source ${s.name} --level error --since 1h\`, fix the crash, then \`boxlite-app deploy\``,
        evidence: errs,
      });
    } else if (s.state === 'failed' || s.state === 'stopped') {
      out.push({ id: 'service_down', severity: 'error', title: `service ${s.name} is ${s.state}`, fix: `\`boxlite-app app restart ${s.name}\`; if it stops again, \`boxlite-app app logs --source ${s.name} --since 1h\``, evidence: errs });
    }
  }

  if (c.database) {
    if (c.database.status === 'unreachable') {
      out.push({ id: 'db_unreachable', severity: 'error', title: 'the database does not answer', fix: 'retry `boxlite-app app db info` in a minute; if it persists, `boxlite-app doctor` and report the error', detail: c.database.error });
    }
    const changed = c.database.migrations.filter((m) => m.status === 'changed');
    for (const m of changed) {
      out.push({ id: 'migration_changed', severity: 'error', title: `${m.file} differs from the version applied in #${m.deployment ?? '?'}`, fix: `restore the applied contents of ${m.file} and add the change as a new file: \`boxlite-app app db migration new <name>\`` });
    }
    const pending = c.database.migrations.filter((m) => m.status === 'pending');
    if (pending.length) {
      out.push({ id: 'pending_migrations', severity: 'warn', title: `${pending.length} migration(s) not applied: ${pending.map((m) => m.file).join(', ')}`, fix: '`boxlite-app apply --yes` (or `boxlite-app deploy`) runs them' });
    }
  }

  if (c.auth.enabled) {
    const ready = c.auth.providers.filter((p) => p.status === 'ready');
    const missing = c.auth.providers.filter((p) => p.status !== 'ready').map((p) => p.name);
    if (!ready.length) out.push({ id: 'auth_not_ready', severity: 'error', title: `sign-in is on but no provider is configured on this platform (${missing.join(', ')})`, fix: 'nothing to do in the app: the platform admin adds the OAuth credentials; meanwhile test with `boxlite-app app auth test-session --email qa@example.com`' });
    else if (missing.length) out.push({ id: 'auth_partial', severity: 'info', title: `sign-in: ${missing.join(', ')} not configured on this platform; ${ready.map((p) => p.name).join(', ')} works`, fix: `remove ${missing.join(', ')} from [auth].providers in boxlite.toml, or leave it: the login page only offers ready providers` });
  }

  const unresolved = c.variables.filter((v) => v.secret && !v.resolved);
  if (unresolved.length) {
    out.push({ id: 'secret_missing', severity: 'error', title: `secret(s) not set on the platform: ${unresolved.map((v) => `${v.name} (${v.source})`).join(', ')}`, fix: 'ask the user to add them in the console (Secrets); never put the value in boxlite.toml or the code' });
  }

  const recent = c.recent_errors.filter((e) => Date.parse(c.generated_at) - Date.parse(e.ts) < 3_600_000);
  if (recent.length && !out.some((f) => f.id === 'crash_loop')) {
    const sources = [...new Set(recent.map((e) => e.source))];
    out.push({ id: 'recent_errors', severity: 'warn', title: `${recent.length} error line(s) in the last hour from ${sources.join(', ')}`, fix: `\`boxlite-app app logs --level error --since 1h\``, evidence: recent.slice(-5).map((e) => `[${e.source}] ${e.line}`) });
  }

  if (c.box?.state === 'stopped') out.push({ id: 'box_asleep', severity: 'info', title: 'the app is asleep (it stops after 15 min without traffic)', fix: 'nothing to do: the next request wakes it in a few seconds' });
  if (c.access.level === 'public' && !c.auth.enabled) out.push({ id: 'public_anonymous', severity: 'info', title: 'the app is public and has no sign-in: anyone with the URL can use it', fix: 'keep it only if the user asked for a public site; otherwise `boxlite-app app access set private`' });
  return rankFindings(out);
}
