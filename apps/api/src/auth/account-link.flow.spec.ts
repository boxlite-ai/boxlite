/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The login-time account link end to end: the real Post-Login Action, run as
 * the bootstrap configurator deploys it, calling the real adopt endpoint.
 *
 * Auth0 is played by `tenant()`, answering the calls the Action makes the way
 * the Auth0 docs describe them: the token endpoint for the link client's
 * Management API token and for the password-realm grant, `users-by-email`,
 * and the link. What only this test can catch is a break in the contract
 * between the Action and the API: a claim one side writes and the other does
 * not read, a key or audience the two disagree on.
 */

import { NotFoundException, UnauthorizedException } from '@nestjs/common'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { TypedConfigService } from '../config/typed-config.service'
import { LinkedIdentityService } from '../user/linked-identity.service'
import { AccountLinkController } from './account-link.controller'
import { AccountLinkService } from './account-link.service'

const SECRET = 'a-shared-secret-of-at-least-32-chars'
const API = 'https://api.dev.example.com'
const DOMAIN = 'example-tenant.us.auth0.com'
const PRIMARY = 'auth0|primary'
const SOCIAL = 'google-oauth2|103'
const PASSWORD = 'correct horse'

type Handler = (event: any, api: any) => Promise<void>
type Call = { url: string; method: string; headers: Record<string, string>; body: any }

function idToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode(claims)}.signature`
}

function tenant(
  options: {
    account?: boolean
    lookup?: number
    signUp?: { status: number; body?: unknown }
    verified?: boolean
    grantError?: string
    idTokenSub?: string
    adopt?: jest.Mock
  } = {},
) {
  const calls: Call[] = []
  const adopt = options.adopt ?? jest.fn().mockResolvedValue(undefined)
  const config = {
    get: jest.fn(() => true),
    getOrThrow: jest.fn(() => SECRET),
  } as unknown as TypedConfigService
  const controller = new AccountLinkController(
    config,
    new AccountLinkService(config, { adopt } as unknown as LinkedIdentityService),
  )
  const account = {
    user_id: PRIMARY,
    email_verified: options.verified ?? true,
    identities: [{ connection: 'boxlite-users' }],
  }
  const exp = Math.floor(Date.now() / 1000) + 600
  const grant = { iss: `https://${DOMAIN}/`, aud: 'link_456', exp, sub: options.idTokenSub ?? PRIMARY }

  async function answer(call: Call): Promise<{ status: number; body?: unknown }> {
    if (call.url === `${API}/api/auth/link/adopt`) {
      try {
        await controller.adopt(call.headers.authorization)
        return { status: 204 }
      } catch (error) {
        if (error instanceof UnauthorizedException) return { status: 401 }
        if (error instanceof NotFoundException) return { status: 404 }
        return { status: 500 }
      }
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
      return { status: 200, body: options.account === false ? [] : [account] }
    }
    if (call.url.startsWith(`https://${DOMAIN}/api/v2/users/`) && call.url.endsWith('/identities')) {
      return { status: 201, body: [] }
    }
    if (call.url === `https://${DOMAIN}/api/v2/users` && call.method === 'POST') {
      return options.signUp ?? { status: 201, body: { user_id: 'auth0|new' } }
    }
    if (call.url === `https://${DOMAIN}/api/v2/users/${encodeURIComponent(PRIMARY)}` && call.method === 'PATCH') {
      return { status: 200, body: {} }
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
  runInNewContext(source, { exports, require, Buffer, fetch, console: { log: () => undefined } })
  return { action: exports, calls, adopt }
}

function transaction() {
  const cache = new Map<string, string>()
  const seen = { renders: [] as Array<{ id: string; vars?: any }>, denied: [] as string[], primary: [] as string[] }
  const api = {
    access: { deny: (reason: string) => seen.denied.push(reason) },
    accessToken: { setCustomClaim: jest.fn() },
    authentication: { setPrimaryUser: (id: string) => seen.primary.push(id) },
    cache: {
      get: (key: string) => cache.has(key) && { value: cache.get(key) },
      set: (key: string, value: string) => cache.set(key, value),
    },
    prompt: { render: (id: string, options?: { vars?: any }) => seen.renders.push({ id, vars: options?.vars }) },
  }
  return { api, seen }
}

function socialLogin(overrides: Record<string, any> = {}) {
  return {
    authorization: {},
    client: { client_id: 'spa_123' },
    connection: { name: 'google-oauth2', strategy: 'google-oauth2' },
    request: { ip: '203.0.113.7' },
    secrets: {
      ACCOUNT_LINK_SECRET: SECRET,
      ACCOUNT_LINK_CLIENT_ID: 'link_456',
      ACCOUNT_LINK_CLIENT_SECRET: 'link-secret',
    },
    transaction: { protocol: 'oidc-basic-profile' },
    user: { user_id: SOCIAL, email: 'Ada@example.com', email_verified: true, name: 'Ada' },
    ...overrides,
  }
}

describe('login-time account link, Action and API together', () => {
  it('links a social login into the password account holding its address', async () => {
    const { action, calls, adopt } = tenant()
    const first = transaction()
    await action.onExecutePostLogin(socialLogin(), first.api)
    expect(first.seen.renders).toEqual([{ id: 'ap_link', vars: expect.objectContaining({ email: 'Ada@example.com' }) }])

    const second = transaction()
    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
      second.api,
    )

    expect(second.seen.denied).toEqual([])
    expect(second.seen.primary).toEqual([PRIMARY])
    expect(adopt).toHaveBeenCalledWith(PRIMARY, SOCIAL)
    const grant = calls.find((call) => call.body?.grant_type?.endsWith('password-realm'))
    expect(grant).toMatchObject({
      headers: expect.objectContaining({ 'auth0-forwarded-for': '203.0.113.7' }),
      body: expect.objectContaining({ realm: 'boxlite-users', username: 'ada@example.com', client_id: 'link_456' }),
    })
    const order = calls.map((call) => call.url)
    const adopted = order.indexOf(`${API}/api/auth/link/adopt`)
    const linked = order.findIndex((url) => url.endsWith('/identities'))
    expect(adopted).toBeGreaterThan(-1)
    expect(linked).toBeGreaterThan(adopted)
    expect(calls[linked].body).toEqual({ provider: 'google-oauth2', user_id: '103' })
  })

  it('asks again after a wrong password, and moves and links nothing', async () => {
    const { action, calls, adopt } = tenant()
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: 'wrong' } } }),
      step.api,
    )

    expect(step.seen.renders).toEqual([
      { id: 'ap_link', vars: expect.objectContaining({ error: expect.stringMatching(/not right/) }) },
    ])
    expect(adopt).not.toHaveBeenCalled()
    expect(calls.some((call) => call.url.endsWith('/identities'))).toBe(false)
  })

  it('ends the login when the password account demands MFA', async () => {
    const { action } = tenant({ grantError: 'mfa_required' })
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
      step.api,
    )

    expect(step.seen.denied).toEqual([expect.stringMatching(/multi-factor/)])
    expect(step.seen.primary).toEqual([])
  })

  it('does not link when BoxLite cannot move the data', async () => {
    const { action, calls } = tenant({ adopt: jest.fn().mockRejectedValue(new Error('database down')) })
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
      step.api,
    )

    expect(step.seen.denied).toEqual([expect.stringMatching(/unavailable/)])
    expect(calls.some((call) => call.url.endsWith('/identities'))).toBe(false)
  })

  it('offers a new password when no password account holds the address', async () => {
    const { action } = tenant({ account: false })
    const step = transaction()

    await action.onExecutePostLogin(socialLogin(), step.api)

    expect(step.seen.renders).toEqual([
      { id: 'ap_link', vars: expect.objectContaining({ lead: expect.stringMatching(/Choose one/) }) },
    ])
  })

  it('creates the password account with the chosen password, then moves and links into it', async () => {
    const { action, calls, adopt } = tenant({ account: false })
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
      step.api,
    )

    const created = calls.find((call) => call.url === `https://${DOMAIN}/api/v2/users`)
    expect(created?.body).toEqual({
      connection: 'boxlite-users',
      email: 'ada@example.com',
      password: PASSWORD,
      email_verified: true,
    })
    expect(adopt).toHaveBeenCalledWith('auth0|new', SOCIAL)
    expect(step.seen.primary).toEqual(['auth0|new'])
  })

  it('asks again with the reason Auth0 gives for a weak new password', async () => {
    const { action, adopt } = tenant({
      account: false,
      signUp: { status: 400, body: { message: 'PasswordStrengthError: Password is too weak' } },
    })
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: 'short' } } }),
      step.api,
    )

    expect(step.seen.renders).toEqual([
      { id: 'ap_link', vars: expect.objectContaining({ error: expect.stringMatching(/too weak/) }) },
    ])
    expect(adopt).not.toHaveBeenCalled()
  })

  it('asks for the existing password when another login signed the address up first', async () => {
    const { action, adopt } = tenant({
      account: false,
      signUp: { status: 409, body: { message: 'The user already exists.' } },
    })
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
      step.api,
    )

    expect(step.seen.renders).toEqual([
      {
        id: 'ap_link',
        vars: expect.objectContaining({
          lead: expect.stringMatching(/already has/),
          error: expect.stringMatching(/now/),
        }),
      },
    ])
    expect(adopt).not.toHaveBeenCalled()
  })

  it.each([
    ['a disabled connection', { status: 400, body: { message: 'Payload validation error: connection is disabled' } }],
    [
      'a link client without create:users',
      { status: 403, body: { message: 'Insufficient scope, expected any of: create:users' } },
    ],
  ])('lets the login through unlinked when Auth0 refuses the sign-up over %s', async (_reason, signUp) => {
    const { action, adopt } = tenant({ account: false, signUp })
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
      step.api,
    )

    expect(step.seen.renders).toEqual([])
    expect(step.seen.denied).toEqual([])
    expect(adopt).not.toHaveBeenCalled()
  })

  it('leaves a social login without an address its own identity', async () => {
    const { action, calls } = tenant()
    const step = transaction()

    await action.onExecutePostLogin(socialLogin({ user: { ...socialLogin().user, email: undefined } }), step.api)

    expect(step.seen.renders).toEqual([])
    expect(calls).toEqual([])
  })

  it('proves an address the provider did not verify with the email Form first', async () => {
    const { action } = tenant()
    const unverified = socialLogin({ user: { ...socialLogin().user, email_verified: false } })
    const first = transaction()
    await action.onExecutePostLogin(unverified, first.api)
    expect(first.seen.renders).toEqual([{ id: 'ap_verify', vars: undefined }])

    const second = transaction()
    await action.onContinuePostLogin({ ...unverified, prompt: { id: 'ap_verify', fields: {} } }, second.api)
    expect(second.seen.renders.map((render) => render.id)).toEqual(['ap_link'])
  })

  it('asks for a new password after the email Form when no password account holds the address', async () => {
    const { action } = tenant({ account: false })
    const unverified = socialLogin({ user: { ...socialLogin().user, email_verified: false } })
    const step = transaction()

    await action.onContinuePostLogin({ ...unverified, prompt: { id: 'ap_verify', fields: {} } }, step.api)

    expect(step.seen.renders).toEqual([
      { id: 'ap_link', vars: expect.objectContaining({ lead: expect.stringMatching(/Choose one/) }) },
    ])
  })

  it('marks an unverified password account verified before moving and linking', async () => {
    const { action, calls } = tenant({ verified: false })
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
      step.api,
    )

    const patch = calls.findIndex((call) => call.method === 'PATCH')
    expect(calls[patch].body).toEqual({ email_verified: true })
    expect(patch).toBeLessThan(calls.findIndex((call) => call.url === `${API}/api/auth/link/adopt`))
    expect(step.seen.primary).toEqual([PRIMARY])
  })

  it('refuses a password grant whose ID token names another account', async () => {
    const { action, adopt } = tenant({ idTokenSub: 'auth0|someone-else' })
    const step = transaction()

    await action.onContinuePostLogin(
      socialLogin({ prompt: { id: 'ap_link', fields: { password: PASSWORD } } }),
      step.api,
    )

    expect(step.seen.denied).toEqual(['Account linking failed'])
    expect(adopt).not.toHaveBeenCalled()
  })

  it('leaves a token refresh its identity without asking the Management API', async () => {
    const { action, calls } = tenant()
    const step = transaction()

    await action.onExecutePostLogin(socialLogin({ transaction: { protocol: 'oauth2-refresh-token' } }), step.api)

    expect(step.seen.denied).toEqual([])
    expect(step.seen.renders).toEqual([])
    expect(calls).toEqual([])
  })

  it('lets a login through unlinked when the Management API throttles the lookup', async () => {
    const { action } = tenant({ lookup: 429 })
    const step = transaction()

    await action.onExecutePostLogin(socialLogin(), step.api)

    expect(step.seen.denied).toEqual([])
    expect(step.seen.renders).toEqual([])
  })
})
