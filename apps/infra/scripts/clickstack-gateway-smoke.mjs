// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { pathToFileURL } from 'node:url'

const DEFAULT_ATTEMPTS = 30
const DEFAULT_RETRY_DELAY_MS = 2_000
const REQUEST_TIMEOUT_MS = 10_000

function requiredUrl(value, label) {
  if (!value) throw new Error(`${label} is required`)
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`${label} must be a credential-free HTTPS URL`)
  }
  return parsed
}

function requiredScopes(location) {
  return new Set((location.searchParams.get('scope') || '').split(/\s+/).filter(Boolean))
}

export function validateOidcRedirect(response, { gatewayUrl, issuer, audience }) {
  if (response.status !== 302) {
    throw new Error(`expected HTTP 302 from the unauthenticated Gateway, received ${response.status}`)
  }
  const locationHeader = response.headers.get('location')
  if (!locationHeader) throw new Error('OIDC redirect is missing the Location header')

  const gateway = requiredUrl(gatewayUrl, 'CLICKSTACK_GATEWAY_URL')
  const expectedAuthorize = new URL('/authorize', requiredUrl(issuer, 'CLICKSTACK_OIDC_ISSUER'))
  const location = new URL(locationHeader)
  if (location.origin !== expectedAuthorize.origin || location.pathname !== expectedAuthorize.pathname) {
    throw new Error('unexpected OIDC authorization endpoint')
  }
  if (!location.searchParams.get('client_id')) {
    throw new Error('OIDC redirect is missing client_id')
  }
  if (location.searchParams.get('redirect_uri') !== new URL('/oauth2/idpresponse', gateway).toString()) {
    throw new Error('unexpected OIDC callback')
  }
  if (location.searchParams.get('audience') !== audience) {
    throw new Error('unexpected OIDC audience')
  }
  if (!requiredScopes(location).has('boxlite-backoffice')) {
    throw new Error('OIDC redirect is missing boxlite-backoffice scope')
  }
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function probeClickStackGateway({
  gatewayUrl,
  issuer,
  audience,
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  fetchImpl = fetch,
}) {
  requiredUrl(gatewayUrl, 'CLICKSTACK_GATEWAY_URL')
  requiredUrl(issuer, 'CLICKSTACK_OIDC_ISSUER')
  if (!audience) throw new Error('CLICKSTACK_OIDC_AUDIENCE is required')
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts must be a positive integer')

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(gatewayUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      try {
        validateOidcRedirect(response, { gatewayUrl, issuer, audience })
        return
      } finally {
        await response.body?.cancel()
      }
    } catch (error) {
      lastError = error
      if (attempt < attempts && retryDelayMs > 0) await pause(retryDelayMs)
    }
  }
  throw new Error(`ClickStack public OIDC entry did not become ready: ${lastError?.message || 'unknown error'}`)
}

async function main() {
  await probeClickStackGateway({
    gatewayUrl: process.env.CLICKSTACK_GATEWAY_URL,
    issuer: process.env.CLICKSTACK_OIDC_ISSUER,
    audience: process.env.CLICKSTACK_OIDC_AUDIENCE,
  })
  console.log('clickstack-gateway-smoke: public OIDC entry is ready')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
