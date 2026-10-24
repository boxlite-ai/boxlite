/** What a signed-in visitor is to the App, sent to it as X-BoxLite-User-Role (app-origin.ts). */
import type { AppRow } from '../db.js';
import type { Ctx } from '../ctx.js';
import { PLATFORM_ORG } from '../orgs.js';
import type { AppUser } from './sessions.js';

/**
 * `owner`: the visitor manages this App in the BoxLite console, that is, signed in to the app with
 * the same account (provider and provider id) as a member of the App's organization. `user`:
 * anyone else. A test user has the role it was created with.
 */
export type EndUserRole = 'owner' | 'user';

export function roleOf(ctx: Pick<Ctx, 'store'>, app: AppRow, user: AppUser): EndUserRole {
  if (user.provider === 'test') return user.test_role === 'owner' ? 'owner' : 'user';
  const member = ctx.store.get(
    'SELECT 1 AS ok FROM console_users cu JOIN org_members m ON m.user_id = cu.id WHERE cu.provider = ? AND cu.provider_id = ? AND m.org_id = ?',
    user.provider,
    user.provider_user_id,
    app.org_id ?? PLATFORM_ORG,
  );
  return member ? 'owner' : 'user';
}
