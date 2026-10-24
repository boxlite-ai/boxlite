/** The console: login/logout, the console API under /console/api (assembled from the route groups here), and the static dashboard. */
import { Hono } from 'hono';
import { consoleViewer, loginRoutes, requireConsoleApi, requireConsolePage } from '../../console-auth.js';
import { githubSignInAvailable, mountConsoleSignIn } from '../../console-signin.js';
import type { Ctx } from '../../ctx.js';
import { fail } from '../../errors.js';
import { RESERVED_NAMES } from '../../platform.js';
import { consoleAppRoutes } from './apps.js';
import { consoleAuthRoutes } from './auth.js';
import { consoleDatabaseRoutes } from './database.js';
import { consoleDeploymentRoutes } from './deployments.js';
import { consoleKit } from './kit.js';
import { consoleLogRoutes } from './logs.js';
import { staticHandler, vendorHandler } from './static.js';
import { consoleVariableRoutes } from './variables.js';
import { consoleVolumeRoutes } from './volumes.js';
import { consoleDomainRoutes } from './domains.js';

/**
 * The console API (/console/api) and the console's static files (/console/). The API speaks the
 * shapes of the dashboard's Apps screens and is built from real CP state. Writes go through the
 * CP's own /v1 routes in-process (actor `console`, kit.ts), or through the same functions those
 * routes and the admin API use (services/apps.ts, deleteApp/restoreApp, Resources.sleep), so
 * validation, activity and the orchestrator are exactly what the CLI gets. One file per tab or
 * concern: apps, deployments, volumes, variables, auth, logs, database.
 */

export function mountConsole(root: Hono, ctx: Ctx): void {
  const login = loginRoutes(ctx, githubSignInAvailable(ctx));
  root.get('/console/login', login.page);
  root.get('/console/vendor/*', vendorHandler);
  root.post('/console/login', login.submit);
  root.on(['GET', 'POST'], '/console/logout', login.logout);
  mountConsoleSignIn(root, ctx);
  root.route('/console/api', consoleApi(root, ctx));
  root.get('/console', (c) => c.redirect('/console/', 308));
  root.get('/console/*', requireConsolePage(ctx), (c) => staticHandler(c, ctx.config.consoleDir));
}

function consoleApi(root: Hono, ctx: Ctx) {
  const api = new Hono();
  const k = consoleKit(root, ctx);
  api.use('*', requireConsoleApi(ctx));

  /** Who is signed in and the organization they work in (orgs.ts); the platform admin has none. */
  api.get('/session', (c) => {
    const v = consoleViewer(ctx, c)!;
    const base = { controlPlane: ctx.config.publicUrl, reservedNames: [...RESERVED_NAMES].sort() };
    if (v.kind === 'admin') return c.json({ ...base, user: 'admin', admin: true, organization: null });
    const apps = ctx.store.get<{ n: number }>('SELECT count(*) AS n FROM apps WHERE org_id = ?', v.org.id)!.n;
    return c.json({
      ...base,
      user: v.user.name ?? v.user.login ?? v.user.email ?? 'you',
      admin: false,
      profile: { name: v.user.name, login: v.user.login, email: v.user.email, avatarUrl: v.user.avatar_url },
      organization: { id: v.org.id, name: v.org.name, role: v.role, suspendedReason: v.org.suspended_reason, appLimit: v.org.app_limit, apps },
    });
  });

  consoleAppRoutes(api, k);
  consoleDeploymentRoutes(api, k);
  consoleVolumeRoutes(api, k);
  consoleDomainRoutes(api, k);
  consoleVariableRoutes(api, k);
  consoleAuthRoutes(api, k);
  consoleLogRoutes(api, k);
  consoleDatabaseRoutes(api, k);

  api.all('*', () => {
    throw fail('not_found', 'no such console API route');
  });
  return api;
}
