// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Pure argument/payload construction for provisioning the Auth0 application
 * and API identities reached through `npm run bootstrap -- --provision-auth0`.
 * The tenant-wide email provider and email-first database/Form/Action policy
 * have separate previewable reconcilers in auth0-email-provider.ts and
 * auth0-login-policy.ts.
 *
 * Tenant settings have no first-class CLI verb and go through `auth0 api`,
 * the raw Management API passthrough.
 *
 * Creating the tenant itself has no Management API and stays manual.
 */

const LOOPBACK_CALLBACK = 'http://127.0.0.1:5555/callback'

function requireHostname(name: any, value: any) {
  if (!value || value !== value.trim() || value.includes('/')) {
    throw new Error(`${name} '${value}' must be a bare hostname`)
  }
  return value
}

/*
 * Callback URLs must cover both front ends that complete an OIDC redirect:
 * the dashboard SPA, and the Rust CLI's `auth login --method browser`, which
 * RFC 8252 §8.3 requires to use the IPv4 loopback literal rather than
 * `localhost`.
 */
export function spaApplicationArgs({ stackDomain, name = 'boxlite-dashboard' }: any) {
  requireHostname('stackDomain', stackDomain)
  const dashboardUrl = `https://${stackDomain}`
  return [
    'apps',
    'create',
    '--name',
    name,
    '--type',
    'spa',
    '--callbacks',
    `${dashboardUrl},${LOOPBACK_CALLBACK}`,
    '--logout-urls',
    dashboardUrl,
    '--json',
  ]
}

// The API identifier becomes OIDC_AUDIENCE verbatim; it is an opaque
// identifier to Auth0, not a URL it ever dereferences.
export function customApiArgs({ stackDomain, name = 'boxlite-api' }: any) {
  requireHostname('stackDomain', stackDomain)
  return ['apis', 'create', '--name', name, '--identifier', `https://${stackDomain}/api`, '--json']
}

/*
 * Without rp_logout_end_session_endpoint_discovery the dashboard's "Sign out"
 * only clears BoxLite's own session: the still-live Auth0 cookie silently
 * re-authenticates and logout looks like a page refresh.
 *
 * enable_public_signup_user_exists_error stays off so /dbconnections/signup
 * answers a duplicate address with the generic invalid_signup rather than
 * user_exists, which would let anyone enumerate registered emails.
 */
export function tenantSettingsArgs() {
  return [
    'api',
    'patch',
    'tenants/settings',
    '--data',
    JSON.stringify({
      oidc_logout: { rp_logout_end_session_endpoint_discovery: true },
      flags: { enable_public_signup_user_exists_error: false },
    }),
  ]
}
