/**
 * Console users and organizations, the way the BoxLite platform does it (apps/api organization
 * service): a user's first sign-in creates their "Default Organization" with them as OWNER; Apps
 * and org secrets belong to an org; members see and change their org's Apps. An org whose owner
 * has no verified email is suspended (no new Apps). New orgs may hold a few Apps at a time, since
 * each costs a Box and a database; the platform admin (admin token) sees every org.
 *
 * Everything from before organizations sits in `org_platform` ("Default Organization"). The legacy
 * owner (by verified email) gets it as their default org on first sign-in instead of a new one.
 */
import { newId } from './auth.js';
import type { Ctx } from './ctx.js';
import { now, type AppRow } from './db.js';
import { fail } from './errors.js';
import type { OAuthProfile } from './oauth-providers.js';

export const PLATFORM_ORG = 'org_platform';
export const DEFAULT_ORG_NAME = 'Default Organization';
export const DEFAULT_LEGACY_OWNER = 'mandalore@polygala.ai';
export const DEFAULT_NEW_ORG_APP_LIMIT = 3;
export const UNVERIFIED_EMAIL_REASON = 'Verify an email address on your GitHub account, then sign in again';

export type OrgRole = 'owner' | 'member';

export interface ConsoleUser {
  id: string;
  provider: string;
  provider_id: string;
  login: string | null;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
  last_login_at: string;
}

export interface Org {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
  suspended_reason: string | null;
  /** Apps the org may hold at a time (deleted ones count until purged); null is unlimited. */
  app_limit: number | null;
}

/** Who is using the console: the platform admin (admin token), or a user working in one org. */
export type Viewer = { kind: 'admin' } | { kind: 'user'; user: ConsoleUser; org: Org; role: OrgRole };

type OrgCtx = Pick<Ctx, 'store' | 'config'>;

const legacyOwner = (ctx: OrgCtx) => ctx.config.orgs?.legacyOwnerEmail ?? DEFAULT_LEGACY_OWNER;
const newOrgAppLimit = (ctx: OrgCtx) => ctx.config.orgs?.newOrgAppLimit ?? DEFAULT_NEW_ORG_APP_LIMIT;

/**
 * Records a sign-in. A new user gets their default org (OWNER): the platform's org for the legacy
 * owner, a new "Default Organization" for everyone else, suspended without a verified email.
 */
export function signInConsoleUser(ctx: OrgCtx, provider: string, profile: OAuthProfile & { login?: string | null }): ConsoleUser {
  const at = now();
  return ctx.store.tx(() => {
    const existing = ctx.store.get<ConsoleUser>('SELECT * FROM console_users WHERE provider = ? AND provider_id = ?', provider, profile.id);
    const id = existing?.id ?? newId('cu');
    if (existing) {
      ctx.store.run('UPDATE console_users SET email = ?, name = ?, avatar_url = ?, login = coalesce(?, login), last_login_at = ? WHERE id = ?', profile.email, profile.name, profile.avatarUrl, profile.login ?? null, at, id);
    } else {
      ctx.store.run('INSERT INTO console_users (id, provider, provider_id, login, email, name, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, provider, profile.id, profile.login ?? null, profile.email, profile.name, profile.avatarUrl, at, at);
    }
    if (!ctx.store.get('SELECT 1 FROM org_members WHERE user_id = ? AND is_default = 1', id)) {
      const legacy = profile.email !== null && profile.email.toLowerCase() === legacyOwner(ctx) && !ctx.store.get('SELECT 1 FROM org_members WHERE org_id = ?', PLATFORM_ORG);
      const orgId = legacy ? PLATFORM_ORG : newId('org');
      if (legacy) ctx.store.run('UPDATE orgs SET created_by = ? WHERE id = ?', id, PLATFORM_ORG);
      else ctx.store.run('INSERT INTO orgs (id, name, created_by, created_at, suspended_reason, app_limit) VALUES (?, ?, ?, ?, ?, ?)', orgId, DEFAULT_ORG_NAME, id, at, profile.email ? null : UNVERIFIED_EMAIL_REASON, newOrgAppLimit(ctx));
      ctx.store.run("INSERT INTO org_members (org_id, user_id, role, is_default, created_at) VALUES (?, ?, 'owner', 1, ?)", orgId, id, at);
    } else if (profile.email) {
      // A verified email lifts the suspension of the user's own default org, as on the platform.
      ctx.store.run('UPDATE orgs SET suspended_reason = NULL WHERE created_by = ? AND suspended_reason = ?', id, UNVERIFIED_EMAIL_REASON);
    }
    return ctx.store.get<ConsoleUser>('SELECT * FROM console_users WHERE id = ?', id)!;
  });
}

/** The viewer behind a console session value: `admin`, or a user id working in their default org. */
export function viewerOf(ctx: Pick<Ctx, 'store'>, session: string | null): Viewer | null {
  if (!session) return null;
  if (session === 'admin') return { kind: 'admin' };
  const user = ctx.store.get<ConsoleUser>('SELECT * FROM console_users WHERE id = ?', session);
  if (!user) return null;
  const m = ctx.store.get<{ org_id: string; role: OrgRole }>('SELECT org_id, role FROM org_members WHERE user_id = ? AND is_default = 1', user.id);
  const org = m ? ctx.store.get<Org>('SELECT * FROM orgs WHERE id = ?', m.org_id) : undefined;
  return org ? { kind: 'user', user, org, role: m!.role } : null;
}

export function canSee(viewer: Viewer, app: AppRow): boolean {
  return viewer.kind === 'admin' || app.org_id === viewer.org.id;
}

/** The org an App created by this viewer belongs to. */
export function orgIdFor(viewer: Viewer): string {
  return viewer.kind === 'admin' ? PLATFORM_ORG : viewer.org.id;
}

/** Refuses a new App in a suspended org or one at its App limit. */
export function assertCanCreate(ctx: Pick<Ctx, 'store'>, viewer: Viewer): void {
  if (viewer.kind === 'admin') return;
  const { org } = viewer;
  if (org.suspended_reason) throw fail('forbidden', `${org.name} is suspended: ${org.suspended_reason}`);
  if (org.app_limit === null) return;
  const held = ctx.store.get<{ n: number }>('SELECT count(*) AS n FROM apps WHERE org_id = ?', org.id)!.n;
  if (held >= org.app_limit) {
    throw fail('quota_exceeded', `${org.name} already has ${held} Apps, its limit`, 'delete an App you no longer need; it stops counting once it is removed for good (7 days after deletion)');
  }
}

/**
 * The value a `[secrets]` reference names: `app/<name>` is the App's own secret, anything else a
 * secret of the App's org (`org/openai`). Other Apps' and other orgs' secrets never resolve.
 */
export function secretValue(ctx: Pick<Ctx, 'store'>, app: AppRow, ref: string): string | undefined {
  if (ref.startsWith(APP_SECRET_SCOPE)) return ctx.store.get<{ value: string }>('SELECT value FROM app_secrets WHERE app_id = ? AND name = ?', app.id, ref.slice(APP_SECRET_SCOPE.length))?.value;
  return ctx.store.get<{ value: string }>('SELECT value FROM org_secrets WHERE org_id = ? AND name = ?', app.org_id ?? PLATFORM_ORG, ref)?.value;
}

/** `app/<name>` references the App's own secret (set by its agent or in the console); any other scope, its organization's. */
export const APP_SECRET_SCOPE = 'app/';
/** The part after `app/`: what an App secret may be called. */
export const APP_SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Stores the App's own secret `app/<name>` (accepts the name with or without `app/`); the value is never logged. */
export function setAppSecret(ctx: Pick<Ctx, 'store'>, app: AppRow, raw: string, value: string, actor: string): { name: string; updated_at: string; created: boolean } {
  const name = appSecretName(raw);
  if (!value) throw fail('invalid_request', 'the value is empty');
  if (value.length > 65_536) throw fail('invalid_request', 'the value is longer than 64 KB');
  const created = !ctx.store.get('SELECT 1 FROM app_secrets WHERE app_id = ? AND name = ?', app.id, name);
  const at = now();
  ctx.store.run('INSERT INTO app_secrets (app_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(app_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', app.id, name, value, at);
  ctx.store.recordActivity(app.id, null, actor, created ? 'secret.set' : 'secret.update', { name: APP_SECRET_SCOPE + name });
  return { name: APP_SECRET_SCOPE + name, updated_at: at, created };
}

export function deleteAppSecret(ctx: Pick<Ctx, 'store'>, app: AppRow, raw: string, actor: string): void {
  const name = appSecretName(raw);
  if (!ctx.store.run('DELETE FROM app_secrets WHERE app_id = ? AND name = ?', app.id, name).changes) {
    throw fail('not_found', `no App secret ${APP_SECRET_SCOPE}${name}`, '`boxlite-app app secrets list` shows the names');
  }
  ctx.store.recordActivity(app.id, null, actor, 'secret.delete', { name: APP_SECRET_SCOPE + name });
}

function appSecretName(raw: string): string {
  const name = raw.startsWith(APP_SECRET_SCOPE) ? raw.slice(APP_SECRET_SCOPE.length) : raw;
  if (!APP_SECRET_NAME_RE.test(name)) throw fail('invalid_request', `"${raw}" is not a secret name`, 'use letters, digits, ".", "_" or "-", e.g. `stripe` (referenced as app/stripe)');
  return name;
}

/** The App's own secret names (never values), as `app/<name>` references. */
export function appSecretNames(ctx: Pick<Ctx, 'store'>, appId: string): { name: string; updated_at: string }[] {
  return ctx.store.all<{ name: string; updated_at: string }>('SELECT name, updated_at FROM app_secrets WHERE app_id = ? ORDER BY name', appId).map((r) => ({ name: APP_SECRET_SCOPE + r.name, updated_at: r.updated_at }));
}

/** The secret names of one org, for the console's "Reference a secret". */
export function orgSecretNames(ctx: Pick<Ctx, 'store'>, orgId: string): { name: string; updated_at: string }[] {
  return ctx.store.all<{ name: string; updated_at: string }>('SELECT name, updated_at FROM org_secrets WHERE org_id = ? ORDER BY name', orgId);
}
