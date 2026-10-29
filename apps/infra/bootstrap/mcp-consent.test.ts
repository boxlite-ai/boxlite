// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('./auth0/mcp-consent.js', import.meta.url), 'utf8')
function fixture() {
  const actions: Record<string, (event: any, api: any) => Promise<void>> = {}
  runInNewContext(source, { exports: actions, URL, require: () => ({ randomUUID }) })
  const event = {
    resource_server: { identifier: 'https://app.test/api/mcp' },
    secrets: {
      MCP_RESOURCE_URL: 'https://app.test/api/mcp',
      MCP_OAUTH_CLIENT_IDS: 'client',
      MCP_CONSENT_URL: 'https://app.test/mcp/consent',
      MCP_CONSENT_SECRET: 'x'.repeat(32),
    },
    user: { user_id: 'user', email_verified: true },
    client: { client_id: 'client', name: 'Agent' },
    transaction: {
      protocol: 'oidc-basic-profile',
      response_type: ['code'],
      requested_scopes: ['boxes:read', 'boxes:write'],
    },
    request: { query: { code_challenge_method: 'S256', code_challenge: 'x'.repeat(43), prompt: 'login' } },
  }
  const denied: string[] = [],
    redirects: any[] = [],
    claims: any[] = [],
    removed: string[] = []
  const api = {
    access: { deny: (reason: string) => denied.push(reason) },
    redirect: {
      encodeToken: (value: any) => JSON.stringify(value),
      sendUserTo: (...args: any[]) => redirects.push(args),
      validateToken: () => ({
        sub: 'user',
        client_id: 'client',
        iss: event.secrets.MCP_RESOURCE_URL,
        resource: event.secrets.MCP_RESOURCE_URL,
        aud: 'boxlite-mcp-continue',
        grant_id: randomUUID(),
        organization_id: randomUUID(),
        scopes: ['boxes:read'],
      }),
    },
    accessToken: {
      setCustomClaim: (...args: any[]) => claims.push(args),
      removeScope: (scope: string) => removed.push(scope),
    },
  }
  return { actions, event, api, denied, redirects, claims, removed }
}

test('MCP Action skips dashboard login and redirects only an allowed code/PKCE login', async () => {
  const f = fixture()
  await f.actions.onExecutePostLogin(f.event, f.api)
  assert.equal(f.denied.length, 0)
  assert.equal(f.redirects[0][0], 'https://app.test/mcp/consent')
  const payload = JSON.parse(f.redirects[0][1].query.challenge).payload
  assert.equal(payload.client_id, 'client')
  assert.deepEqual(payload.scopes, ['boxes:read', 'boxes:write'])
  f.event.resource_server.identifier = 'https://dashboard-api.test'
  await f.actions.onExecutePostLogin(f.event, f.api)
  assert.equal(f.redirects.length, 1)
})

test('MCP Action denies silent/refresh/implicit/unknown-client/missing-PKCE flows', async () => {
  const mutations = [
    (e: any) => {
      e.request.query.prompt = 'none'
    },
    (e: any) => {
      e.transaction.protocol = 'oauth2-refresh-token'
    },
    (e: any) => {
      e.transaction.response_type = ['token']
    },
    (e: any) => {
      e.client.client_id = 'unknown'
    },
    (e: any) => {
      delete e.request.query.code_challenge
    },
    (e: any) => {
      e.transaction.requested_scopes.push('offline_access')
    },
    (e: any) => {
      e.user.email_verified = false
    },
  ]
  for (const mutate of mutations) {
    const f = fixture()
    mutate(f.event)
    await f.actions.onExecutePostLogin(f.event, f.api)
    assert.equal(f.denied.length, 1)
    assert.equal(f.redirects.length, 0)
  }
})

test('MCP continuation narrows scopes and rejects mismatched identities and invalid signed state', async () => {
  const f = fixture()
  await f.actions.onContinuePostLogin(f.event, f.api)
  assert.equal(f.claims[0][0], 'https://boxlite.ai/mcp/grant_id')
  assert.deepEqual(f.removed, ['boxes:write', 'boxes:delete'])
  const payload = f.api.redirect.validateToken()
  f.api.redirect.validateToken = () => ({ ...payload, sub: 'other' })
  await f.actions.onContinuePostLogin(f.event, f.api)
  assert.equal(f.denied.length, 1)
  f.api.redirect.validateToken = () => {
    throw new Error('state mismatch')
  }
  await f.actions.onContinuePostLogin(f.event, f.api)
  assert.equal(f.denied.length, 2)
})
