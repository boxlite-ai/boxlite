/** What a signed-in visitor is to the App, sent to it as X-BoxLite-User-Role (app-origin.ts). */
import type { AppRow } from '../db'
import type { Ctx } from '../ctx'
import type { AppUser } from './sessions'

/**
 * `owner`: the visitor manages this App in the BoxLite console, that is, signed in to the app with
 * the same account (provider and provider id) as a member of the App's organization. `user`:
 * anyone else. A test user has the role it was created with.
 */
export type EndUserRole = 'owner' | 'user'

export async function roleOf(ctx: Pick<Ctx, 'organizationMember'>, app: AppRow, user: AppUser): Promise<EndUserRole> {
  if (user.provider === 'test') return user.test_role === 'owner' ? 'owner' : 'user'
  return (await ctx.organizationMember?.(app.org_id!, user.provider, user.provider_user_id)) ? 'owner' : 'user'
}
