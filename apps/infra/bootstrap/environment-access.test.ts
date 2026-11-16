// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createRequire } from 'node:module'
import { runAction } from './tests/action-harness.js'
import { hydrateLoginPolicyAction, parseAuth0LoginPolicyOptions, parseInternalAccessAllowedEmailDomains } from './auth0-login-policy.js'
import targets from '../auth0/targets.json' with { type: 'json' }

const template = readFileSync(new URL('./auth0/login-policy.js', import.meta.url), 'utf8')
test('bootstrap reads domain defaults from its stage environment and rejects invalid configuration', () => {
  const args = ['--tenant', targets.dev.auth0TenantDomain, '--client-id', 'dashboard', '--connection', 'users', '--api-audience', 'https://api.test']
  const value = ' Example.COM,example.net,example.com '
  assert.deepEqual(parseAuth0LoginPolicyOptions(args, { OIDC_INTERNAL_ACCESS_ALLOWED_EMAIL_DOMAINS: value }).internalAccessAllowedEmailDomains, ['example.com', 'example.net'])
  assert.equal(parseAuth0LoginPolicyOptions(args, {}).internalAccessAllowedEmailDomains, undefined)
  assert.deepEqual(parseInternalAccessAllowedEmailDomains(''), [])
  for (const invalid of ['*.example.com', 'tester@example.com', 'https://example.com', 'example.com,,example.net', '-example.com', 'example.com.', 'localhost']) {
    assert.throws(() => parseAuth0LoginPolicyOptions(args, { OIDC_INTERNAL_ACCESS_ALLOWED_EMAIL_DOMAINS: invalid }), /exact DNS domains/)
  }
})
function policy(stage = 'dev', domains = 'company.example') {
  const code = hydrateLoginPolicyAction(template, {
    clientId: 'dashboard', connectionName: 'users', formId: 'verification',
    tenant: targets[stage as keyof typeof targets]?.auth0TenantDomain ?? 'custom.auth0.com',
    apiAudience: 'https://api.test', mcpResourceUrl: 'https://api.test/mcp',
    internalAccessAllowedEmailDomains: parseInternalAccessAllowedEmailDomains(domains),
  })
  const exports: Record<string, (event: any, api: any) => Promise<void>> = {}
  const unexpectedFetch = () => { throw new Error('Login admission must not call a provider API') }
  runAction(code, new URL('./auth0/login-policy.js', import.meta.url), { exports, fetch: unexpectedFetch, console })
  return exports
}
const user = (email = 'tester@example.com', metadata: unknown = {}, verified = true) => ({
  user_id: 'google-oauth2|tester', email, email_verified: verified, app_metadata: metadata,
})
async function login(identity: unknown, options: { stage?: string; domains?: string; client?: string; audience?: string; protocol?: string; database?: boolean } = {}) {
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
  const action = policy(options.stage, options.domains)
  await action.onExecutePostLogin(event, api)
  return { denied, claims, forms, action, event, api }
}

for (const stage of ['dev', 'stage']) {
  test(`${stage}: verified company domain and exact granted email can sign in`, async () => {
    assert.deepEqual((await login(user(' Person@company.example '), { stage })).denied, [])
    const granted = await login(user('Tester@Example.com', { [`boxlite_${stage}_access`]: { email: 'tester@example.com', allowed: true } }), { stage })
    assert.deepEqual(granted.denied, [])
    assert.equal(granted.claims.email_verified, true)
  })
  test(`${stage}: rejects ungranted, forged domain, wrong-email and wrong-environment grants`, async () => {
    for (const identity of [
      user(), user('tester@company.example.example.com'), user('tester@mail.company.example'),
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
test('configured domains replace the company default and match only complete domains', async () => {
  for (const email of ['tester@example.com', 'tester@EXAMPLE.NET']) {
    assert.deepEqual((await login(user(email), { domains: ' Example.COM,example.net,example.com ' })).denied, [])
  }
  for (const email of ['tester@company.example', 'tester@sub.example.com', 'tester@example.com.attacker.test']) {
    assert.equal((await login(user(email), { domains: 'example.com,example.net' })).denied.length, 1)
  }
  assert.equal((await login(user('tester@company.example'), { domains: '' })).denied.length, 1)
  const grant = { boxlite_dev_access: { email: 'tester@example.com', allowed: true } }
  assert.deepEqual((await login(user('tester@example.com', grant), { domains: '' })).denied, [])
})
test('explicit revoke also overrides the corporate default; blocked or unverified identities cannot use grants', async () => {
  const grant = { boxlite_dev_access: { email: 'tester@company.example', allowed: false } }
  assert.equal((await login(user('tester@company.example', grant))).denied.length, 1)
  assert.equal((await login({ ...user('tester@company.example'), blocked: true })).denied.length, 1)
  assert.equal((await login(user('tester@company.example', {}, false))).denied.length, 1)
})
test('verification Form is preserved and exact continuation checks admission after mailbox proof', async () => {
  const result = await login(user('tester@company.example', {}, false), { database: true })
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

for (const allowed of [true, false]) {
  test(`linked login uses the final primary identity grant: allowed=${allowed}`, async () => {
    const email = 'tester@gmail.com'
    const primary = {
      ...user(email, { boxlite_dev_access: { email, allowed } }),
      user_id: 'auth0|primary', name: 'Primary identity',
      identities: [{ provider: 'auth0', connection: 'users' }, { provider: 'github', connection: 'github' }],
    }
    const source = hydrateLoginPolicyAction(template, {
      clientId: 'dashboard', connectionName: 'users', formId: 'verification',
      tenant: targets.dev.auth0TenantDomain, apiAudience: 'https://api.test',
      accountLinkApiOrigin: 'https://api.test', accountLinkFormId: 'link',
      internalAccessAllowedEmailDomains: [],
    })
    const exports: Record<string, (event: any, api: any) => Promise<void>> = {}
    const requests: string[] = [], selected: string[] = [], denied: string[] = []
    const claims: Record<string, unknown> = {}
    runAction(source, new URL('./auth0/login-policy.js', import.meta.url), {
      exports, Buffer, require: createRequire(import.meta.url), console,
      fetch: async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname
        requests.push(`${init.method ?? 'GET'} ${path}`)
        if (path === '/api/v2/users-by-email') return new Response(JSON.stringify([primary]))
        if (path === '/api/auth/link/adopt') return new Response(null, { status: 204 })
        if (path === '/api/v2/users/auth0%7Cprimary/identities') return new Response('{}', { status: 201 })
        throw new Error(`Unexpected request: ${path}`)
      },
    })
    await exports.onExecutePostLogin({
      client: { client_id: 'dashboard' }, connection: { name: 'google-oauth2', strategy: 'google-oauth2' },
      resource_server: { identifier: 'https://api.test' }, transaction: { protocol: 'oidc-basic-profile' },
      user: { ...user(email, { boxlite_dev_access: { email, allowed: true } }),
        identities: [{ provider: 'google-oauth2', connection: 'google-oauth2' }] },
      secrets: { ACCOUNT_LINK_SECRET: 'fixture-link-secret-not-production' },
    }, {
      cache: { get: () => ({ value: 'fixture-management-token' }) },
      authentication: { setPrimaryUser: (id: string) => selected.push(id) },
      access: { deny: (message: string) => denied.push(message) },
      accessToken: { setCustomClaim: (name: string, value: unknown) => { claims[name] = value } },
    })
    assert.deepEqual(selected, ['auth0|primary'])
    assert.deepEqual(requests, ['GET /api/v2/users-by-email', 'POST /api/auth/link/adopt', 'POST /api/v2/users/auth0%7Cprimary/identities'])
    if (allowed) {
      assert.deepEqual(denied, [])
      assert.equal(claims.name, 'Primary identity')
      assert.equal(claims.email_verified, true)
    } else {
      assert.equal(denied.length, 1)
      assert.match(denied[0], /restricted/)
      assert.deepEqual(claims, {})
    }
  })
}
