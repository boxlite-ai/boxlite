// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { probeClickStackGateway, validateOidcRedirect } from './clickstack-gateway-smoke.mjs'

const input = {
  gatewayUrl: 'https://clickstack.dev.boxlite.ai/clickstack',
  issuer: 'https://employees.example.com/',
  audience: 'https://backoffice.boxlite.ai',
}

function oidcRedirect(overrides = {}) {
  const location = new URL('/authorize', input.issuer)
  location.searchParams.set('client_id', 'clickstack-client')
  location.searchParams.set('redirect_uri', 'https://clickstack.dev.boxlite.ai/oauth2/idpresponse')
  location.searchParams.set('response_type', 'code')
  location.searchParams.set('scope', 'openid profile email boxlite-backoffice')
  location.searchParams.set('audience', input.audience)
  return {
    status: 302,
    headers: new Headers({ location: location.toString() }),
    body: null,
    ...overrides,
  }
}

test('accepts the expected employee OIDC authorization redirect', () => {
  assert.doesNotThrow(() => validateOidcRedirect(oidcRedirect(), input))
})

test('rejects a successful page response that bypasses OIDC', () => {
  assert.throws(() => validateOidcRedirect(oidcRedirect({ status: 200 }), input), /expected HTTP 302/)
})

test('rejects redirects to the wrong identity provider or callback', () => {
  const wrongIssuer = oidcRedirect()
  wrongIssuer.headers = new Headers({ location: 'https://customer.example.com/authorize' })
  assert.throws(() => validateOidcRedirect(wrongIssuer, input), /unexpected OIDC authorization endpoint/)

  const wrongCallback = oidcRedirect()
  const location = new URL(wrongCallback.headers.get('location'))
  location.searchParams.set('redirect_uri', 'https://attacker.example.com/callback')
  wrongCallback.headers = new Headers({ location: location.toString() })
  assert.throws(() => validateOidcRedirect(wrongCallback, input), /unexpected OIDC callback/)
})

test('rejects redirects missing the required audience or scope', () => {
  const missingAudience = oidcRedirect()
  const audienceLocation = new URL(missingAudience.headers.get('location'))
  audienceLocation.searchParams.delete('audience')
  missingAudience.headers = new Headers({ location: audienceLocation.toString() })
  assert.throws(() => validateOidcRedirect(missingAudience, input), /unexpected OIDC audience/)

  const missingScope = oidcRedirect()
  const scopeLocation = new URL(missingScope.headers.get('location'))
  scopeLocation.searchParams.set('scope', 'openid profile email')
  missingScope.headers = new Headers({ location: scopeLocation.toString() })
  assert.throws(() => validateOidcRedirect(missingScope, input), /missing boxlite-backoffice scope/)
})

test('retries a transient public endpoint failure before accepting the OIDC redirect', async () => {
  let calls = 0
  await probeClickStackGateway({
    ...input,
    attempts: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls++
      return calls === 1 ? { status: 503, headers: new Headers(), body: null } : oidcRedirect()
    },
  })

  assert.equal(calls, 2)
})
