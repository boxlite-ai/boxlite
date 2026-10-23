import type { AppRow, Deployment } from './db.js';
import type { Ctx } from './ctx.js';

/**
 * Activity as the console shows it: who (key …last4, console, admin, system), what in words,
 * when, and where the object it touched lives. The CP's activity rows name routes
 * (`POST /envs/main/deployments`); this maps them to sentences and links.
 */

export type ActorKind = 'agent' | 'console' | 'admin' | 'system';

/** Where an Activity row's object lives in the console. */
export interface ActivityLink {
  tab: 'overview' | 'deployments' | 'logs' | 'auth' | 'database' | 'volumes' | 'variables';
  section?: string;
  deployment?: number;
}

export interface ActivityView {
  id: string;
  at: string;
  actor: string;
  actorKind: ActorKind;
  action: string;
  detail?: string;
  link?: ActivityLink;
}

export function actorKind(by: string): ActorKind {
  if (by.startsWith('key:')) return 'agent';
  if (by === 'console' || by === 'admin') return by;
  return 'system';
}

/** key …2pjx / console / admin / system: who did it, in the words the console uses everywhere. */
export function actorLabel(by: string): string {
  if (by.startsWith('key:')) return `key ${by.slice(4)}`;
  return actorKind(by) === 'system' ? 'system' : by;
}

type Row = { id: number; env: string | null; actor: string; action: string; detail: string | null; ts: string };
type Rule = [RegExp, (m: RegExpExecArray) => string, ActivityLink?];

const RULES: Rule[] = [
  [/^app\.create$/, () => 'created the app', { tab: 'overview' }],
  [/^app\.delete$/, () => 'deleted the app'],
  [/^app\.restore$/, () => 'restored the app', { tab: 'overview' }],
  [/^key\.rotate$/, () => 'rotated the App key', { tab: 'overview' }],
  [/^key\.issue$/, () => 'issued another App key', { tab: 'overview' }],
  [/^secret\.set$/, () => 'stored a secret', { tab: 'variables' }],
  [/^secret\.update$/, () => 'replaced a secret', { tab: 'variables' }],
  [/^secret\.delete$/, () => 'deleted a secret', { tab: 'variables' }],
  [/^volume\.delete$/, () => 'deleted a file on a volume', { tab: 'volumes' }],
  [/^auth\.purge_test_users$/, () => 'removed the test users', { tab: 'auth' }],
  [/^box\.sleep$/, () => 'put the Box to sleep', { tab: 'overview' }],
  [/^auth\.user\.signout$/, () => 'signed a user out', { tab: 'auth' }],
  [/^auth\.user\.block$/, () => 'blocked a user', { tab: 'auth' }],
  [/^auth\.user\.unblock$/, () => 'unblocked a user', { tab: 'auth' }],
  [/^auth\.test_session$/, () => 'opened a test session', { tab: 'auth' }],
  [/^db\.sql\.write$/, () => 'ran a write query', { tab: 'database', section: 'sql' }],
  [/^db\.reset$/, () => 'reset the database', { tab: 'database' }],
  [/^db\.proxy$/, () => 'connected to the database through the local proxy', { tab: 'database', section: 'connection' }],
  [/^db\.export$/, () => 'exported the database', { tab: 'database' }],
  [/^db\.import$/, () => 'imported rows into the database', { tab: 'database', section: 'tables' }],
  [/^read status$/, () => 'read the status'],
  [/^read context$/, () => 'read the context'],
  [/^POST \/envs\/[^/]+\/deployments$/, () => 'started a deployment', { tab: 'deployments' }],
  [/^POST \/envs\/[^/]+\/deployments\/(\d+)\/cancel$/, (m) => `cancelled #${m[1]}`, { tab: 'deployments' }],
  [/^POST \/envs\/[^/]+\/plan$/, () => 'planned a change'],
  [/^POST \/uploads$/, () => 'uploaded the project', { tab: 'deployments' }],
  [/^PUT \/envs\/[^/]+\/access$/, () => 'changed access', { tab: 'overview' }],
  [/^POST \/envs\/[^/]+\/services\/([^/]+)\/restart$/, (m) => (m[1] === 'all' ? 'restarted all services' : `restarted ${m[1]}`), { tab: 'deployments', section: 'services' }],
  [/^POST \/envs$/, () => 'created an environment'],
  [/^DELETE \/envs\/([^/]+)$/, (m) => `deleted environment ${m[1]}`],
  [/^POST \/envs\/[^/]+\/db\/snapshots$/, () => 'took a database backup', { tab: 'database', section: 'backups' }],
  [/^POST \/envs\/[^/]+\/db\/restore$/, () => 'restored the database', { tab: 'database', section: 'backups' }],
  [/^POST \/envs\/[^/]+\/db\/reset$/, () => 'reset the database', { tab: 'database' }],
  [/^POST \/envs\/[^/]+\/schedules\/([^/]+)\/run$/, (m) => `ran schedule ${m[1]}`, { tab: 'deployments', section: 'services' }],
];

/** Per-file upload calls are plumbing of one upload; reads through POST /db/sql change nothing (writes are db.sql.write). */
const HIDDEN = [/^PUT \/uploads\//, /^POST \/uploads\/[^/]+\/complete$/, /^POST \/envs\/[^/]+\/db\/sql$/, /^POST \/envs\/[^/]+\/db\/import$/, /^POST \/envs\/[^/]+\/auth\/test-sessions$/];

function parse(detail: string | null): Record<string, unknown> | null {
  if (!detail || detail === 'null') return null;
  try {
    const v = JSON.parse(detail) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The detail in words; the app's own name and internal ids are left out. */
function detailText(action: string, d: Record<string, unknown> | null): string | undefined {
  if (!d) return undefined;
  if (action === 'app.delete' && typeof d.purge_after === 'string') return `kept until ${d.purge_after.slice(0, 16).replace('T', ' ')} UTC`;
  if (action.startsWith('auth.') && typeof d.email === 'string') return d.email;
  if (action === 'db.sql.write' && Array.isArray(d.statements)) return d.statements.map(String).join(', ');
  if (action === 'db.proxy') {
    const secs = Math.round(Number(d.duration_ms ?? 0) / 1000);
    const len = secs < 120 ? `${secs} s` : `${Math.round(secs / 60)} min`;
    return `${d.role === 'owner' ? 'read-write (owner)' : 'read-only'} · ${d.open ? `open for ${len}` : len} · ${d.connections ?? 0} connection${d.connections === 1 ? '' : 's'}${d.refused ? ` · ${d.refused} refused` : ''}`;
  }
  if (action === 'db.export') return d.table ? `${d.format} of ${d.table}` : `${d.format} dump`;
  if (action === 'db.import' && typeof d.table === 'string') return `${d.rows} row${d.rows === 1 ? '' : 's'} into ${d.table}`;
  if (action === 'db.reset' && Array.isArray(d.dropped)) return `dropped ${d.dropped.length} table${d.dropped.length === 1 ? '' : 's'}`;
  return undefined;
}

/** The deployment a "started a deployment" row created: same env and actor, created just before the row. */
function deploymentFor(deployments: Deployment[], r: Row): Deployment | undefined {
  const at = Date.parse(r.ts);
  return deployments.find((d) => d.by === r.actor && Date.parse(d.created_at) <= at && at - Date.parse(d.created_at) < 30_000);
}

export function activityView(ctx: Pick<Ctx, 'store'>, app: AppRow, envName: string, limit = 100): ActivityView[] {
  const rows = ctx.store.all<Row>(
    'SELECT id, env, actor, action, detail, ts FROM activity WHERE app_id = ? AND (env IS NULL OR env = ?) ORDER BY id DESC LIMIT ?',
    app.id,
    envName,
    limit * 3,
  );
  const env = ctx.store.envByName(app.id, envName);
  const deployments = env ? ctx.store.deployments(env.id, 200) : [];
  const out: ActivityView[] = [];
  for (const r of rows) {
    if (HIDDEN.some((re) => re.test(r.action))) continue;
    let action = r.action;
    let link: ActivityLink | undefined;
    for (const [re, label, target] of RULES) {
      const m = re.exec(r.action);
      if (!m) continue;
      action = label(m);
      link = target;
      break;
    }
    let detail = detailText(r.action, parse(r.detail));
    if (/^POST \/envs\/[^/]+\/deployments$/.test(r.action)) {
      const d = deploymentFor(deployments, r);
      if (d) {
        detail = `#${d.number}${d.message ? ` · ${d.message}` : ''}`;
        link = { tab: 'deployments', deployment: d.number };
      }
    }
    const cancelled = /\/deployments\/(\d+)\/cancel$/.exec(r.action);
    if (cancelled) link = { tab: 'deployments', deployment: Number(cancelled[1]) };
    out.push({ id: String(r.id), at: r.ts, actor: actorLabel(r.actor), actorKind: actorKind(r.actor), action, ...(detail ? { detail } : {}), ...(link ? { link } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}
