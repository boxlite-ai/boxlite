// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Pure argument/payload construction for provisioning an Auth0 tenant through
 * the `auth0` CLI, replacing the manual dashboard steps a fresh tenant would
 * otherwise need. Reached through `npm run bootstrap -- --provision-auth0`.
 *
 * The device-code token minted by `auth0 login` already carries the scopes all
 * of this needs (create:clients, create:resource_servers, create:actions,
 * update:actions, update:tenant_settings), so there is no
 * create-an-M2M-app-first chicken-and-egg.
 *
 * Two operations have no first-class CLI verb and go through `auth0 api`, the
 * raw Management API passthrough:
 *   - binding a deployed Action to the post-login flow (`auth0 actions deploy`
 *     explicitly does NOT bind: "Before an action can be bound to a flow, the
 *     action must be deployed")
 *   - flipping the tenant's RP-initiated-logout discovery setting
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

export function createActionArgs({ code, name = 'boxlite-custom-claims', runtime = 'node18' }: any) {
  if (!code || !code.trim()) throw new Error('the post-login Action body is required')
  return ['actions', 'create', '--name', name, '--trigger', 'post-login', '--runtime', runtime, '--code', code, '--json']
}

export function deployActionArgs(actionId: any) {
  if (!actionId) throw new Error('actionId is required to deploy an Action')
  return ['actions', 'deploy', actionId]
}

/*
 * PATCH /api/v2/actions/triggers/post-login/bindings replaces the whole
 * binding list, so callers must pass every binding they intend to keep — a
 * bare single-entry payload silently unbinds anything else already on the
 * flow.
 */
interface ExistingActionBinding {
  action?: { id?: string }
  display_name?: string
}

export function bindActionArgs({ actionId, displayName = 'boxlite-custom-claims', existingBindings = [] }: {
  actionId: string
  displayName?: string
  existingBindings?: ExistingActionBinding[]
}) {
  if (!actionId) throw new Error('actionId is required to bind an Action')
  // Require action.id in the filter, not just a mismatch: a binding without an
  // `action` object passes an inequality test and then throws in the map. A
  // binding whose Action has been deleted is the shape to expect, and losing
  // the whole rebind to one of those is worse than dropping it.
  const preserved = existingBindings
    .filter(
      (binding): binding is ExistingActionBinding & { action: { id: string } } =>
        Boolean(binding?.action?.id && binding.action.id !== actionId && binding.display_name !== displayName),
    )
    .map((binding) => ({
      ref: { type: 'action_id', value: binding.action.id },
      display_name: binding.display_name,
    }))

  const bindings = [...preserved, { ref: { type: 'action_id', value: actionId }, display_name: displayName }]
  return ['api', 'patch', 'actions/triggers/post-login/bindings', '--data', JSON.stringify({ bindings })]
}

// Without this the dashboard's "Sign out" only clears BoxLite's own session:
// the still-live Auth0 cookie silently re-authenticates and logout looks like
// a page refresh.
export function enableRpLogoutDiscoveryArgs() {
  return [
    'api',
    'patch',
    'tenants/settings',
    '--data',
    JSON.stringify({ oidc_logout: { rp_logout_end_session_endpoint_discovery: true } }),
  ]
}
