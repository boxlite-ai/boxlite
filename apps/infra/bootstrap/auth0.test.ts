// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { customApiArgs, spaApplicationArgs, tenantSettingsArgs } from './auth0.js'

function valueAfter(args: any, flag: any) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

test('spaApplicationArgs registers both the dashboard and the CLI loopback callback', () => {
  const args = spaApplicationArgs({ dashboardDomain: 'app.dev.example.com' })
  // RFC 8252 §8.3 requires the IPv4 loopback literal, not `localhost`.
  assert.equal(valueAfter(args, '--callbacks'), 'https://app.dev.example.com,http://127.0.0.1:5555/callback')
  assert.equal(valueAfter(args, '--logout-urls'), 'https://app.dev.example.com')
  assert.equal(valueAfter(args, '--type'), 'spa')
})

test('spaApplicationArgs rejects a URL where a hostname is required', () => {
  assert.throws(() => spaApplicationArgs({ dashboardDomain: 'https://dev.example.com' }), /must be a bare hostname/)
  assert.throws(() => spaApplicationArgs({ dashboardDomain: '' }), /must be a bare hostname/)
})

test('customApiArgs names the API by the host it answers on, with no path', () => {
  assert.equal(
    valueAfter(customApiArgs({ apiHost: 'api.dev.example.com' }), '--identifier'),
    'https://api.dev.example.com',
  )
  assert.throws(() => customApiArgs({ apiHost: 'https://api.dev.example.com' }), /must be a bare hostname/)
})

test('tenantSettingsArgs sets logout discovery and keeps public signup non-enumerable', () => {
  const args = tenantSettingsArgs()
  assert.deepEqual(args.slice(0, 3), ['api', 'patch', 'tenants/settings'])
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')), {
    oidc_logout: { rp_logout_end_session_endpoint_discovery: true },
    flags: { enable_public_signup_user_exists_error: false },
  })
})
