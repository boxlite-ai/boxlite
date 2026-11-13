// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { hydrateLoginPolicyAction } from './auth0-login-policy.js'
import targets from '../auth0/targets.json' with { type: 'json' }

const template = readFileSync(new URL('./auth0/login-policy.js', import.meta.url), 'utf8')
function policy(stage = 'dev') {
  const code = hydrateLoginPolicyAction(template, {
    clientId: 'dashboard', connectionName: 'users', formId: 'verification',
    tenant: targets[stage as keyof typeof targets]?.auth0TenantDomain ?? 'custom.auth0.com',
    apiAudience: 'https://api.test', mcpResourceUrl: 'https://api.test/mcp',
  })
  const exports: Record<string, (event: any, api: any) => Promise<void>> = {}
  const unexpectedFetch = () => { throw new Error('Login admission must not call a provider API') }
  runInNewContext(code, { exports, fetch: unexpectedFetch, console })
  return exports
}
const user = (email = 'tester@example.com', metadata: unknown = {}, verified = true) => ({
  user_id: 'google-oauth2|tester', email, email_verified: verified, app_metadata: metadata,
})
async function login(identity: unknown, options: { stage?: string; client?: string; audience?: string; protocol?: string; database?: boolean } = {}) {
  const denied: string[] = [], claims: Record<string, unknown> = {}, forms: string[] = []
  const event = {
    user: identity, client: { client_id: options.client ?? 'dashboard' },
    resource_server: { identifier: options.audience ?? 'https://api.test' },
    transaction: { protocol: options.protocol ?? 'oidc-basic-profile' },
    connection: { name: 'users', strategy: options.database ? 'auth0' : 'google-oauth2' },
  }
  const api = { access: { deny: (message: string) => denied.push(message) },
    accessToken: { setCustomClaim: (key: string, value: unknown) => { claims[key] = value } },
    prompt: { render: (id: string) => forms.push(id) } }
  const action = policy(options.stage)
  await action.onExecutePostLogin(event, api)
  return { denied, claims, forms, action, event, api }
}

for (const stage of ['dev', 'stage']) {
  test(`${stage}: verified company domain and exact granted email can sign in`, async () => {
    assert.deepEqual((await login(user(' Person@POLYGALA.AI '), { stage })).denied, [])
    const granted = await login(user('Tester@Example.com', { [`boxlite_${stage}_access`]: { email: 'tester@example.com', allowed: true } }), { stage })
    assert.deepEqual(granted.denied, [])
    assert.equal(granted.claims.email_verified, true)
  })
  test(`${stage}: rejects ungranted, forged domain, wrong-email and wrong-environment grants`, async () => {
    for (const identity of [
      user(), user('tester@polygala.ai.example.com'), user('tester@mail.polygala.ai'),
      user('tester@example.com', { [`boxlite_${stage}_access`]: { email: 'other@example.com', allowed: true } }),
      user('tester@example.com', { [`boxlite_${stage === 'dev' ? 'stage' : 'dev'}_access`]: { email: 'tester@example.com', allowed: true } }),
      { ...user(), user_metadata: { [`boxlite_${stage}_access`]: { email: 'tester@example.com', allowed: true } } },
    ]) {
      const result = await login(identity, { stage })
      assert.equal(result.denied.length, 1)
      assert.deepEqual(result.claims, {})
    }
  })
}
test('explicit revoke also overrides the corporate default; blocked or unverified identities cannot use grants', async () => {
  const grant = { boxlite_dev_access: { email: 'tester@polygala.ai', allowed: false } }
  assert.equal((await login(user('tester@polygala.ai', grant))).denied.length, 1)
  assert.equal((await login({ ...user('tester@polygala.ai'), blocked: true })).denied.length, 1)
  assert.equal((await login(user('tester@polygala.ai', {}, false))).denied.length, 1)
})
test('verification Form is preserved and exact continuation checks admission after mailbox proof', async () => {
  const result = await login(user('tester@polygala.ai', {}, false), { database: true })
  assert.deepEqual(result.forms, ['verification'])
  assert.deepEqual(result.denied, [])
  await result.action.onContinuePostLogin({ ...result.event, prompt: { id: 'verification' } }, result.api)
  assert.deepEqual(result.denied, [])
  assert.equal(result.claims.email_verified, true)
  const external = await login(user('tester@example.com', {}, false), { database: true })
  await external.action.onContinuePostLogin({ ...external.event, prompt: { id: 'verification' } }, external.api)
  assert.equal(external.denied.length, 1)
})
test('API and MCP audiences are gated for other clients and refresh exchanges', async () => {
  for (const audience of ['https://api.test', 'https://api.test/mcp']) {
    assert.equal((await login(user(), { client: 'third-party', audience })).denied.length, 1)
    assert.equal((await login(user(), { client: 'third-party', audience, protocol: 'oauth2-refresh-token' })).denied.length, 1)
  }
  assert.deepEqual((await login(user(), { client: 'unrelated', audience: 'unrelated' })).denied, [])
})
test('production and unknown tenants preserve their original verified social login behavior', async () => {
  for (const stage of ['prod', 'custom']) assert.deepEqual((await login(user(), { stage })).denied, [])
})
