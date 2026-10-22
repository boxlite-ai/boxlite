import type { AppRow, EnvRow } from './db.js';
import type { Ctx } from './ctx.js';
import * as enduser from './enduser/management.js';
import type { UserView } from './enduser/sessions.js';

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
  /** ready: the control plane holds BoxLite's OAuth app for it; not_configured: it does not. */
  status: 'ready' | 'not_configured';
  /** This environment's [auth] lists it. */
  declared: boolean;
  /** The one platform-wide OAuth callback the provider's app must list. */
  redirectUri: string;
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
}

const ACTOR = 'console';

function userView(u: UserView): EndUserView {
  return { id: u.id, email: u.email, name: u.name, provider: u.provider, firstSeen: u.first_seen, lastSeen: u.last_seen, sessions: u.active_sessions, blocked: u.blocked };
}

export const endUserAuth = {
  authStatus(ctx: Ctx, app: AppRow, env: EnvRow): AuthStatusView {
    const s = enduser.authStatus(ctx, app, env);
    const declared = new Map(s.providers.map((p) => [p.name, p.status]));
    const methods: SignInMethodView[] = enduser.redirectUris(ctx).map((r) => ({ provider: r.provider, status: r.status, declared: declared.has(r.provider), redirectUri: r.redirect_uri }));
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
      note: s.enabled && missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not configured on this control plane yet` : null,
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
