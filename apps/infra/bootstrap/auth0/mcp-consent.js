// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const SCOPES = ['boxes:read', 'boxes:write', 'boxes:delete']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isMcp(event) {
  return Boolean(event.secrets.MCP_RESOURCE_URL && event.resource_server?.identifier === event.secrets.MCP_RESOURCE_URL)
}

function allowedClient(event) {
  return (event.secrets.MCP_OAUTH_CLIENT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .includes(event.client.client_id)
}

exports.onExecutePostLogin = async (event, api) => {
  if (!isMcp(event)) return
  const query = event.request?.query || {}
  const requested = event.transaction?.requested_scopes || []
  const types = event.transaction?.response_type || []
  if (
    !allowedClient(event) ||
    event.transaction?.protocol !== 'oidc-basic-profile' ||
    types.length !== 1 ||
    types[0] !== 'code' ||
    String(query.prompt || '')
      .split(' ')
      .includes('none') ||
    query.code_challenge_method !== 'S256' ||
    typeof query.code_challenge !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge) ||
    requested.includes('offline_access') ||
    !requested.includes('boxes:read') ||
    event.user?.email_verified !== true
  ) {
    api.access.deny('MCP requires a verified user and interactive authorization code with S256 PKCE')
    return
  }
  try {
    const consent = new URL(event.secrets.MCP_CONSENT_URL)
    const resource = new URL(event.secrets.MCP_RESOURCE_URL)
    if (
      consent.protocol !== 'https:' ||
      consent.pathname !== '/mcp/consent' ||
      consent.search ||
      consent.hash ||
      resource.protocol !== 'https:' ||
      !event.secrets.MCP_CONSENT_SECRET ||
      event.secrets.MCP_CONSENT_SECRET.length < 32
    )
      throw new Error()
    const challenge = api.redirect.encodeToken({
      secret: event.secrets.MCP_CONSENT_SECRET,
      expiresInSeconds: 300,
      payload: {
        aud: 'boxlite-mcp-consent',
        client_id: event.client.client_id,
        client_name: event.client.name,
        resource: resource.href,
        scopes: SCOPES.filter((scope) => requested.includes(scope)),
        nonce: require('crypto').randomUUID(),
      },
    })
    api.redirect.sendUserTo(consent.href, { query: { challenge } })
  } catch {
    api.access.deny('MCP consent is unavailable')
  }
}

exports.onContinuePostLogin = async (event, api) => {
  if (!isMcp(event) || !allowedClient(event)) return api.access.deny('Invalid MCP continuation')
  try {
    // Auth0 validates the signature, expiration, and state against this /continue transaction.
    const payload = api.redirect.validateToken({
      secret: event.secrets.MCP_CONSENT_SECRET,
      tokenParameterName: 'session_token',
    })
    const requested = event.transaction?.requested_scopes || []
    if (
      payload.sub !== event.user.user_id ||
      payload.client_id !== event.client.client_id ||
      payload.iss !== event.secrets.MCP_RESOURCE_URL ||
      payload.resource !== event.secrets.MCP_RESOURCE_URL ||
      payload.aud !== 'boxlite-mcp-continue' ||
      !UUID.test(payload.grant_id) ||
      !UUID.test(payload.organization_id) ||
      !Array.isArray(payload.scopes) ||
      !payload.scopes.includes('boxes:read') ||
      payload.scopes.some((scope) => !SCOPES.includes(scope) || !requested.includes(scope))
    )
      throw new Error()
    for (const scope of SCOPES) if (!payload.scopes.includes(scope)) api.accessToken.removeScope(scope)
    api.accessToken.setCustomClaim('https://boxlite.ai/mcp/grant_id', payload.grant_id)
    api.accessToken.setCustomClaim('https://boxlite.ai/mcp/organization_id', payload.organization_id)
    api.accessToken.setCustomClaim('email_verified', event.user.email_verified === true)
  } catch {
    api.access.deny('MCP consent validation failed')
  }
}
