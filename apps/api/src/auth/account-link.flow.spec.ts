/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The login-time account link end to end: the real Post-Login Action, its
 * placeholders filled as the bootstrap configurator fills them, calling the
 * real adopt endpoint.
 *
 * Auth0 is played by `tenant()`, answering the calls the Action makes the way
 * the Auth0 docs describe them: the token endpoint for the link client's
 * Management API token and for the password-realm grant, `users-by-email`,
 * and the link. What only this test can catch is a break in the contract
 * between the Action and the API: a claim one side writes and the other does
 * not read, a key or audience the two disagree on. The cases follow the
 * design's table of every login against the accounts holding its address
 * (POL-735).
 */

import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'
import { UserService } from '../user/user.service'
import { AccountLinkController } from './account-link.controller'
import { AccountLinkService } from './account-link.service'

const SECRET = 'a-shared-secret-of-at-least-32-chars'
const API = 'https://api.dev.example.com'
const DOMAIN = 'example-tenant.us.auth0.com'
const PASSWORD_USER = 'auth0|primary'
const GOOGLE_USER = 'google-oauth2|103'
const GITHUB_USER = 'github|55'
const PASSWORD = 'correct horse'

type Handler = (event: any, api: any) => Promise<void>
type Call = { url: string; method: string; headers: Record<string, string>; body: any }
type Account = { user_id: string; email_verified: boolean; identities: Array<Record<string, string>> }

function identity(userId: string) {
  const [provider, id] = userId.split('|')
  return { provider, user_id: id, connection: provider === 'auth0' ? 'boxlite-users' : provider }
}

/** An Auth0 user holding the address; `linked` names the sign-ins already linked to it. */
function account(userId: string, { verified = true, linked = [] as string[] } = {}): Account {
  return { user_id: userId, email_verified: verified, identities: [userId, ...linked].map(identity) }
}

function idToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`
}

function tenant(
  options: {
    // The users `users-by-email` answers with; a password account by default.
    accounts?: Account[]
    lookup?: number
    grantError?: string
    idTokenSub?: string
    // Claims that replace the ID token's own, which are valid for this tenant.
    grant?: Record<string, unknown>
    adopt?: jest.Mock
  } = {},
) {
  const calls: Call[] = []
  const accounts = options.accounts ?? [account(PASSWORD_USER)]
  const adopt = options.adopt ?? jest.fn().mockResolvedValue(undefined)
  const config = {
    get: jest.fn(() => true),
    getOrThrow: jest.fn(() => SECRET),
  } as unknown as TypedConfigService
  const controller = new AccountLinkController(
    config,
    new AccountLinkService(config, { adopt } as unknown as LinkedIdentityService, {} as UserService),
  )
  const passwordAccount = accounts.find((user) => user.identities.some((each) => each.connection === 'boxlite-users'))
  const grant = {
    iss: `https://${DOMAIN}/`,
    aud: 'link_456',
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: options.idTokenSub ?? passwordAccount?.user_id,
    ...options.grant,
  }

  async function endpoint(answer: () => Promise<unknown>, status: number) {
    try {
      return { status, body: await answer() }
    } catch (error) {
      if (error instanceof UnauthorizedException) return { status: 401 }
      if (error instanceof NotFoundException) return { status: 404 }
      return { status: 500 }
    }
  }

  async function answer(call: Call): Promise<{ status: number; body?: unknown }> {
    if (call.url === `${API}/api/auth/link/adopt` && call.method === 'POST') {
      return endpoint(() => controller.adopt(call.headers.authorization), 204)
    }
    if (call.url === `https://${DOMAIN}/oauth/token` && call.body.grant_type === 'client_credentials') {
      return { status: 200, body: { access_token: 'management-token', expires_in: 86400 } }
    }
    if (call.url === `https://${DOMAIN}/oauth/token`) {
      if (options.grantError) return { status: 403, body: { error: options.grantError, error_description: 'refused' } }
      return call.body.password === PASSWORD
        ? { status: 200, body: { id_token: idToken(grant) } }
        : { status: 403, body: { error: 'invalid_grant', error_description: 'Wrong email or password.' } }
    }
    if (call.url.startsWith(`https://${DOMAIN}/api/v2/users-by-email`)) {
      if (options.lookup) return { status: options.lookup, body: { error: 'too_many_requests' } }
      return { status: 200, body: accounts }
    }
    if (call.url.startsWith(`https://${DOMAIN}/api/v2/users/`) && call.url.endsWith('/identities')) {
      return { status: 201, body: [] }
    }
    return { status: 404 }
  }

  async function fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    const call = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body && JSON.parse(init.body),
    }
    calls.push(call)
    const { status, body } = await answer(call)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body ?? {},
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    }
  }

  const source = readFileSync(join(__dirname, '../../../infra/bootstrap/auth0/login-policy.js'), 'utf8')
    .replace('__BOXLITE_CLIENT_ID_JSON__', JSON.stringify('spa_123'))
    .replace('__BOXLITE_DB_CONNECTION_JSON__', JSON.stringify('boxlite-users'))
    .replace('__EMAIL_VERIFICATION_FORM_ID_JSON__', JSON.stringify('ap_verify'))
    .replace('__ACCOUNT_LINK_API_ORIGIN_JSON__', JSON.stringify(API))
    .replace('__ACCOUNT_LINK_FORM_ID_JSON__', JSON.stringify('ap_link'))
    .replace('__AUTH0_DOMAIN_JSON__', JSON.stringify(DOMAIN))
  expect(source).not.toMatch(/__[A-Z_]+_JSON__/)
  const exports: Record<string, Handler> = {}
  runInNewContext(source, { exports, require, Buffer, URL, fetch, console: { log: () => undefined } })
  return { action: exports, calls, adopt }
}

function transaction() {
  const cache = new Map<string, string>()
  const seen = {
    renders: [] as Array<{ id: string; vars?: any }>,
    denied: [] as string[],
    primary: [] as string[],
    redirects: [] as string[],
  }
  const api = {
    access: { deny: (reason: string) => seen.denied.push(reason) },
    accessToken: { setCustomClaim: jest.fn() },
    authentication: { setPrimaryUser: (id: string) => seen.primary.push(id) },
    cache: {
      get: (key: string) => cache.has(key) && { value: cache.get(key) },
      set: (key: string, value: string) => cache.set(key, value),
    },
    redirect: { sendUserTo: (url: string) => seen.redirects.push(url) },
    prompt: { render: (id: string, options?: { vars?: any }) => seen.renders.push({ id, vars: options?.vars }) },
  }
  return { api, seen }
}

/** An unlinked browser login through `userId`'s sign-in, a moment ago. */
function login(userId: string, { user, ...overrides }: Record<string, any> = {}) {
  const { provider } = identity(userId)
  return {
    authorization: {},
    client: { client_id: 'spa_123' },
    connection:
      provider === 'auth0' ? { name: 'boxlite-users', strategy: 'auth0' } : { name: provider, strategy: provider },
    request: { ip: '203.0.113.7', hostname: 'auth.example.com' },
    secrets: {
      ACCOUNT_LINK_SECRET: SECRET,
      ACCOUNT_LINK_CLIENT_ID: 'link_456',
      ACCOUNT_LINK_CLIENT_SECRET: 'link-secret',
    },
    authentication: {
      methods: [{ name: provider === 'auth0' ? 'pwd' : 'federated', timestamp: new Date().toISOString() }],
    },
    stats: { logins_count: 4 },
    transaction: { protocol: 'oidc-basic-profile', redirect_uri: 'https://app.example.com/callback' },
    user: {
      user_id: userId,
      email: 'Ada@example.com',
      email_verified: true,
      name: 'Ada',
      identities: [identity(userId)],
      ...user,
    },
    ...overrides,
  }
}

const google = (overrides: Record<string, any> = {}) => login(GOOGLE_USER, overrides)

/** Every link the Action asked the Management API for: what went into which user. */
function links(calls: Call[]) {
  return calls
    .filter((call) => call.url.endsWith('/identities'))
    .map((call) => ({
      into: decodeURIComponent(call.url.split('/users/')[1].replace('/identities', '')),
      ...call.body,
    }))
}

describe('login-time account link, Action and API together', () => {
  describe('a Google login', () => {
    it('goes straight in when no other account holds the address', async () => {
      const { action, adopt, calls } = tenant({ accounts: [] })
      const step = transaction()

      await action.onExecutePostLogin(google(), step.api)

      expect(step.seen).toEqual({ renders: [], denied: [], primary: [], redirects: [] })
      expect(step.api.accessToken.setCustomClaim).toHaveBeenCalledWith('email_verified', true)
      expect(adopt).not.toHaveBeenCalled()
      expect(links(calls)).toEqual([])
    })

    it('folds into the password account holding the address once its password checks out', async () => {
      const { action, calls, adopt } = tenant()
      const first = transaction()
      await action.onExecutePostLogin(google(), first.api)
      expect(first.seen.renders).toEqual([
        { id: 'ap_link', vars: expect.objectContaining({ lead: expect.stringMatching(/Enter its password/) }) },
      ])

      const second = transaction()
      await action.onContinuePostLogin(
        google({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
        second.api,
      )

      expect(second.seen.denied).toEqual([])
      expect(adopt.mock.calls).toEqual([[PASSWORD_USER, GOOGLE_USER]])
      expect(links(calls)).toEqual([{ into: PASSWORD_USER, provider: 'google-oauth2', user_id: '103' }])
      expect(second.seen.primary).toEqual([PASSWORD_USER])
      const grant = calls.find((call) => call.body?.grant_type?.endsWith('password-realm'))
      expect(grant).toMatchObject({
        headers: expect.objectContaining({ 'auth0-forwarded-for': '203.0.113.7' }),
        body: expect.objectContaining({ realm: 'boxlite-users', username: 'ada@example.com', client_id: 'link_456' }),
      })
      const order = calls.map((call) => call.url)
      expect(order.indexOf(`${API}/api/auth/link/adopt`)).toBeGreaterThan(-1)
      expect(order.findIndex((url) => url.endsWith('/identities'))).toBeGreaterThan(
        order.indexOf(`${API}/api/auth/link/adopt`),
      )
    })

    it("leaves a GitHub account apart from the password account to GitHub's own next login", async () => {
      const { action, calls, adopt } = tenant({ accounts: [account(PASSWORD_USER), account(GITHUB_USER)] })
      const step = transaction()

      await action.onContinuePostLogin(google({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }), step.api)

      expect(adopt.mock.calls).toEqual([[PASSWORD_USER, GOOGLE_USER]])
      expect(links(calls)).toEqual([{ into: PASSWORD_USER, provider: 'google-oauth2', user_id: '103' }])
    })
  })

  describe('a GitHub login', () => {
    it('goes on as it is when only social accounts hold the address', async () => {
      const { action, adopt, calls } = tenant({ accounts: [account(GOOGLE_USER)] })
      const step = transaction()

      await action.onExecutePostLogin(login(GITHUB_USER), step.api)

      expect(step.seen).toEqual({ renders: [], denied: [], primary: [], redirects: [] })
      expect(adopt).not.toHaveBeenCalled()
      expect(links(calls)).toEqual([])
    })

    it('joins the account a password and Google already share, with its password', async () => {
      const { action, calls, adopt } = tenant({ accounts: [account(PASSWORD_USER, { linked: [GOOGLE_USER] })] })
      const step = transaction()

      await action.onContinuePostLogin(
        login(GITHUB_USER, { prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
        step.api,
      )

      expect(adopt.mock.calls).toEqual([[PASSWORD_USER, GITHUB_USER]])
      expect(links(calls)).toEqual([{ into: PASSWORD_USER, provider: 'github', user_id: '55' }])
      expect(step.seen.primary).toEqual([PASSWORD_USER])
    })
  })

  describe('the proof', () => {
    it('asks again after a wrong password, and moves and links nothing', async () => {
      const { action, calls, adopt } = tenant()
      const step = transaction()

      await action.onContinuePostLogin(google({ prompt: { id: 'ap_link', fields: { password: 'wrong' } } }), step.api)

      expect(step.seen.renders).toEqual([
        {
          id: 'ap_link',
          vars: expect.objectContaining({ error: expect.stringMatching(/not right/) }),
        },
      ])
      expect(adopt).not.toHaveBeenCalled()
      expect(links(calls)).toEqual([])
    })

    it('asks for the password when the page comes back without one', async () => {
      const { action, adopt } = tenant()
      const step = transaction()

      await action.onContinuePostLogin(google({ prompt: { id: 'ap_link', fields: {} } }), step.api)

      expect(step.seen.renders).toEqual([
        { id: 'ap_link', vars: expect.objectContaining({ error: 'Enter the password.' }) },
      ])
      expect(adopt).not.toHaveBeenCalled()
    })

    it('proves an address the provider did not verify with the email Form first', async () => {
      const { action } = tenant()
      const unverified = google({ user: { email_verified: false } })
      const first = transaction()
      await action.onExecutePostLogin(unverified, first.api)
      expect(first.seen.renders).toEqual([{ id: 'ap_verify', vars: undefined }])

      const second = transaction()
      await action.onContinuePostLogin({ ...unverified, prompt: { id: 'ap_verify', fields: {} } }, second.api)
      expect(second.seen.renders).toEqual([
        { id: 'ap_link', vars: expect.objectContaining({ lead: expect.stringMatching(/Enter its password/) }) },
      ])
    })

    it('ends the login when the password account demands MFA', async () => {
      const { action } = tenant({ grantError: 'mfa_required' })
      const step = transaction()

      await action.onContinuePostLogin(google({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }), step.api)

      expect(step.seen.denied).toEqual([expect.stringMatching(/multi-factor/)])
      expect(step.seen.primary).toEqual([])
    })

    it('refuses a password grant whose ID token names another account', async () => {
      const { action, adopt } = tenant({ idTokenSub: 'auth0|someone-else' })
      const step = transaction()

      await action.onContinuePostLogin(google({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }), step.api)

      expect(step.seen.denied).toEqual(['Account linking failed'])
      expect(adopt).not.toHaveBeenCalled()
    })

    it.each([
      ['another tenant as its issuer', { iss: 'https://another-tenant.us.auth0.com/' }],
      ['another client as its audience', { aud: 'another-client' }],
      ['an expiry in the past', { exp: Math.floor(Date.now() / 1000) - 60 }],
    ])('refuses a password grant whose ID token has %s', async (_case, grant) => {
      const { action, adopt } = tenant({ grant })
      const step = transaction()

      await action.onContinuePostLogin(google({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }), step.api)

      expect(step.seen.denied).toEqual(['Account linking failed'])
      expect(adopt).not.toHaveBeenCalled()
    })
  })

  describe('what is left alone', () => {
    it('leaves an account whose address was never verified out of the link', async () => {
      const { action, adopt } = tenant({ accounts: [account(PASSWORD_USER, { verified: false })] })
      const step = transaction()

      await action.onExecutePostLogin(google(), step.api)

      expect(step.seen.renders).toEqual([])
      expect(adopt).not.toHaveBeenCalled()
    })

    it('lets a user already linked to its account through without a lookup', async () => {
      const { action, calls } = tenant()
      const step = transaction()

      await action.onExecutePostLogin(
        google({ user: { identities: [identity(GOOGLE_USER), identity(GITHUB_USER)] } }),
        step.api,
      )

      expect(step.seen.renders).toEqual([])
      expect(calls).toEqual([])
    })

    it('leaves a login without an address its own identity', async () => {
      const { action, calls } = tenant()
      const step = transaction()

      await action.onExecutePostLogin(google({ user: { email: undefined } }), step.api)

      expect(step.seen.renders).toEqual([])
      expect(calls).toEqual([])
    })

    it('leaves a token refresh its identity without asking the Management API', async () => {
      const { action, calls } = tenant()
      const step = transaction()

      await action.onExecutePostLogin(google({ transaction: { protocol: 'oauth2-refresh-token' } }), step.api)

      expect(step.seen.denied).toEqual([])
      expect(step.seen.renders).toEqual([])
      expect(calls).toEqual([])
    })

    it('lets a login through unlinked when the Management API throttles the lookup', async () => {
      const { action } = tenant({ lookup: 429 })
      const step = transaction()

      await action.onExecutePostLogin(google(), step.api)

      expect(step.seen.denied).toEqual([])
      expect(step.seen.renders).toEqual([])
    })

    it('does not link when BoxLite cannot move the data', async () => {
      const { action, calls } = tenant({ adopt: jest.fn().mockRejectedValue(new Error('database down')) })
      const step = transaction()

      await action.onContinuePostLogin(google({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }), step.api)

      expect(step.seen.denied).toEqual([expect.stringMatching(/unavailable/)])
      expect(links(calls)).toEqual([])
    })
  })
})
