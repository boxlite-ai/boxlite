// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

test('customApiArgs derives the identifier that becomes OIDC_AUDIENCE', () => {
  assert.equal(
    valueAfter(customApiArgs({ stackDomain: 'dev.example.com' }), '--identifier'),
    'https://dev.example.com/api',
  )
})

test('tenantSettingsArgs sets logout discovery and keeps public signup non-enumerable', () => {
  const args = tenantSettingsArgs()
  assert.deepEqual(args.slice(0, 3), ['api', 'patch', 'tenants/settings'])
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')), {
    oidc_logout: { rp_logout_end_session_endpoint_discovery: true },
    flags: { enable_public_signup_user_exists_error: false },
  })
})

/*
 * The host bootstrap actually registers.
 *
 * `spaApplicationArgs` takes a dashboard host and the tests above prove what it
 * does with one; the defect this guards was one level up, where the caller
 * handed it the stage domain under that name. Auth0 matches a redirect_uri
 * exactly and provisioning is not idempotent, so a stage that serves its
 * dashboard elsewhere would be left with an application that refuses every
 * login and no second run to repair it.
 *
 * Read from the source because `provisionAuth0` is internal to a script that
 * talks to three clouds; what is asserted is the one expression that decides
 * the host, and the shape it replaced.
 */
test('bootstrap registers the host the dashboard is served from, not the stage domain', () => {
  const source = readFileSync(fileURLToPath(new URL('./bootstrap.ts', import.meta.url)), 'utf8')
  assert.match(
    source,
    /spaApplicationArgs\(\{ dashboardDomain: publicHostsFor\(\{ domain: stackDomain, dashboardDomain \}\)\.dashboard \}\)/,
    'the callback URL must name the dashboard host, through the one function that composes it',
  )
  assert.match(
    source,
    /provisionAuth0\(\{ stackDomain, dashboardDomain: stageConfigLoad\.payload\.DASHBOARD_DOMAIN \?\? null \}\)/,
    'and the override must come from the snapshot being stored, not from the shell',
  )
})
