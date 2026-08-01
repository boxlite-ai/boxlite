// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/**
 * Auth0 Post-Login Action: copy the caller's identity claims onto the access
 * token.
 *
 * Auth0 does not put `email`, `email_verified`, or `name` in an access token by
 * default — they live in the ID token. The API authenticates from the access
 * token alone (apps/api/src/auth/jwt.strategy.ts), so these are the claims an
 * Auth0 access token must carry. (That strategy also reads `sub`, and
 * `cid`/`uid`/`username` on other providers' tokens; none of those need setting
 * here.) Without `email_verified` it creates the user with
 * `emailVerified: false`, which suspends the user's organization; without
 * `email`/`name` the user is created as 'Unknown' with an empty address.
 *
 * Install with `npm run bootstrap -- --provision-auth0`, which creates,
 * deploys, and binds this Action to the post-login flow. To do it by hand:
 * Auth0 Dashboard → Actions → Library → Build Custom → paste this body →
 * Deploy → Flows → Login → drag onto the flow → Apply.
 */
exports.onExecutePostLogin = async (event, api) => {
  if (event.authorization) {
    api.accessToken.setCustomClaim('email_verified', event.user.email_verified)
    api.accessToken.setCustomClaim('email', event.user.email)
    api.accessToken.setCustomClaim('name', event.user.name)
  }
}
