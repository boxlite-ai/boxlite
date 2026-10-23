import { configuredProviders, oauthClientFor } from './enduser/config.js';
import { senderOf, senderView } from './enduser/email-sender.js';
import type { AppRow, EnvRow } from './db.js';
import type { Ctx } from './ctx.js';
import * as enduser from './enduser/management.js';
import type { UserView } from './enduser/sessions.js';
import { OAUTH_PROVIDERS } from './oauth-providers.js';

/**
 * The console's view of end-user sign-in (the Auth tab), mapped from src/enduser/management.ts. User
 * operations run as actor `console` (enduser/management.ts records the activity itself).
 */

export interface EndUserView {
  id: string;
  email: string | null;
  name: string | null;
  provider: string;
  firstSeen: string | null;
  lastSeen: string | null;
  sessions: number;
  blocked: boolean;
}

export interface SignInMethodView {
  provider: string;
  label: string;
  /** ready: an OAuth app signs users in for it (the App's own, or BoxLite's); not_configured: none. */
  status: 'ready' | 'not_configured';
  /** This environment's [auth] lists it. */
  declared: boolean;
  /** The one platform-wide OAuth callback the provider's app must list. */
  redirectUri: string;
  /** Whose OAuth app signs users in: BoxLite's (`shared`) or the App's own. */
  keys: 'shared' | 'own';
  /** The App's own OAuth client id, when it has one (the secret is never returned). */
  clientId: string | null;
  /** BoxLite runs an OAuth app for this provider, so "BoxLite-managed keys" can be chosen. */
  managedAvailable: boolean;
}

export interface AuthStatusView {
  /** [auth] is in the environment's configuration, so the proxy signs visitors in. */
  declared: boolean;
  providers: string[];
  protect: string[];
  /** Sign-in works: [auth] is declared and at least one of its providers is ready. */
  enforced: boolean;
  methods: SignInMethodView[];
  loginUrl: string;
  users: number;
  note: string | null;
  /** The App's SMTP sender for email code sign-in (never the password). */
  emailSender: { configured: boolean; host: string | null; port: number | null; username: string | null; from: string | null; passwordSet: boolean };
}

const ACTOR = 'console';

/** What the declared but unusable providers still need, in the owner's words. */
function noteFor(missing: string[]): string {
  const oauth = missing.filter((p) => p !== 'email');
  const parts = oauth.length ? [`${oauth.map((p) => OAUTH_PROVIDERS[p]?.label ?? p).join(', ')} ${oauth.length === 1 ? 'needs' : 'need'} an OAuth app before anyone can sign in with ${oauth.length === 1 ? 'it' : 'them'}`] : [];
  if (missing.includes('email')) parts.push('email sign-in needs a mail sender before anyone can get a code');
  return parts.join('; ');
}

function userView(u: UserView): EndUserView {
  return { id: u.id, email: u.email, name: u.name, provider: u.provider, firstSeen: u.first_seen, lastSeen: u.last_seen, sessions: u.active_sessions, blocked: u.blocked };
}

export const endUserAuth = {
  authStatus(ctx: Ctx, app: AppRow, env: EnvRow): AuthStatusView {
    const s = enduser.authStatus(ctx, app, env);
    const declared = new Map(s.providers.map((p) => [p.name, p.status]));
    const managed = configuredProviders(ctx);
    const methods: SignInMethodView[] = enduser.redirectUris(ctx).map((r) => {
      const client = oauthClientFor(ctx, app, r.provider);
      return {
        provider: r.provider,
        label: OAUTH_PROVIDERS[r.provider]!.label,
        status: client ? 'ready' : 'not_configured',
        declared: declared.has(r.provider),
        redirectUri: r.redirect_uri,
        keys: client?.own ? 'own' : 'shared',
        clientId: client?.own ? client.clientId : null,
        managedAvailable: managed.includes(r.provider),
      };
    });
    const enforced = s.enabled && s.providers.some((p) => p.status === 'ready');
    const missing = s.providers.filter((p) => p.status !== 'ready').map((p) => p.name);
    return {
      declared: s.enabled,
      providers: s.providers.map((p) => p.name),
      protect: s.protect,
      enforced,
      methods,
      loginUrl: s.login_url,
      users: s.users,
      note: s.enabled && missing.length ? noteFor(missing) : null,
      emailSender: (({ password_set, ...v }) => ({ ...v, passwordSet: password_set }))(senderView(senderOf(ctx, app))),
    };
  },
  async listUsers(ctx: Ctx, app: AppRow, env: EnvRow, search?: string): Promise<EndUserView[]> {
    return enduser.listUsers(ctx, app, env, { search }).map(userView);
  },
  async signOutUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string): Promise<void> {
    enduser.signOutUser(ctx, app, env, userId, ACTOR);
  },
  async blockUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string): Promise<void> {
    enduser.blockUser(ctx, app, env, userId, ACTOR);
  },
  async unblockUser(ctx: Ctx, app: AppRow, env: EnvRow, userId: string): Promise<void> {
    enduser.unblockUser(ctx, app, env, userId, ACTOR);
  },
  exportUsersCsv(ctx: Ctx, app: AppRow, env: EnvRow): string {
    return enduser.exportUsersCsv(ctx, app, env);
  },
};
