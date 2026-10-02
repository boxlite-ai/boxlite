/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}))

import { createHash } from 'node:crypto'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { SignJWT, jwtVerify } from 'jose'
import { AccountLinkController, buildSecondAuthorizeUrl } from './account-link.controller'
import { AccountLinkService, readAccountLinkSession } from './account-link.service'

const post = axios.post as jest.Mock

const REDIRECT_SECRET = 'redirect-secret-value-of-32-chars!'
const SECRET = new TextEncoder().encode(REDIRECT_SECRET)
const TENANT = 'https://auth.dev.boxlite.ai'
const CALLBACK_URL = 'https://api.dev.boxlite.ai/api/auth/link/callback'
const DB_CONNECTION = 'Username-Password-Authentication'
const SPA_CLIENT = 'dashboard-spa'
const SOCIAL_USER_ID = 'google-oauth2|103'
const PRIMARY_USER_ID = 'auth0|primary'

const SESSION_CLAIMS = { email: 'ada@example.com', connection: DB_CONNECTION, callback: CALLBACK_URL }

function makeController(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'oidc.accountLink.enabled': true,
    'oidc.accountLink.redirectSecret': REDIRECT_SECRET,
    'oidc.accountLink.clientId': SPA_CLIENT,
    'oidc.accountLink.authorizeUrl': `${TENANT}/authorize`,
    'oidc.accountLink.issuer': `${TENANT}/`,
    'oidc.accountLink.tokenUrl': `${TENANT}/oauth/token`,
    'oidc.accountLink.continueUrl': `${TENANT}/continue`,
    ...overrides,
  }
  const configService = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`account-link.controller.spec: unexpected config key "${key}"`)
      return values[key]
    }),
  }
  const auth0Management = {
    usersByEmail: jest.fn().mockResolvedValue([
      {
        user_id: PRIMARY_USER_ID,
        identities: [{ provider: 'auth0', user_id: 'primary', connection: DB_CONNECTION }],
      },
    ]),
    linkIdentity: jest.fn().mockResolvedValue(undefined),
    // The tenant's own record of the password account, unverified unless a
    // test says otherwise.
    getUser: jest.fn().mockResolvedValue({ user_id: PRIMARY_USER_ID, email: 'ada@example.com', email_verified: false }),
  }
  const linkedIdentity = { adopt: jest.fn().mockResolvedValue(undefined) }
  const service = new AccountLinkService(configService as any, auth0Management as any, linkedIdentity as any)
  const response = { redirect: jest.fn() }
  return {
    controller: new AccountLinkController(configService as any, service),
    service,
    auth0Management,
    linkedIdentity,
    response,
  }
}

function actionToken(
  claims: Record<string, unknown> = SESSION_CLAIMS,
  { subject = SOCIAL_USER_ID, expiresIn = '60s', secret = SECRET }: Partial<Record<string, any>> = {},
) {
  const token = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresIn)
  if (subject) token.setSubject(subject)
  return token.sign(secret)
}

/** An ID token the tenant's token endpoint would return for the second sign-in. */
function idToken(claims: Record<string, unknown> = {}) {
  const token = new SignJWT({
    iss: `${TENANT}/`,
    aud: SPA_CLIENT,
    sub: PRIMARY_USER_ID,
    email: 'ada@example.com',
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
  if (claims.exp === undefined) token.setExpirationTime('5m')
  return token.sign(new TextEncoder().encode('tenant-key-the-api-never-sees'))
}

/** The `location` the controller handed to `res.redirect`, already parsed. */
function redirectedTo(response: { redirect: jest.Mock }): URL {
  expect(response.redirect).toHaveBeenCalledTimes(1)
  const [status, location] = response.redirect.mock.calls[0]
  expect(status).toBe(302)
  return new URL(location)
}

/** Run the start leg and hand back the authorize URL it produced. */
async function started(controller: AccountLinkController, response: { redirect: jest.Mock }) {
  await controller.start(await actionToken(), 'tx-1', response as any)
  const authorize = redirectedTo(response)
  response.redirect.mockClear()
  return authorize
}

/** The claims of the token the callback carried back to `/continue`. */
async function continueClaims(response: { redirect: jest.Mock }) {
  const location = redirectedTo(response)
  expect(`${location.origin}${location.pathname}`).toBe(`${TENANT}/continue`)
  expect(location.searchParams.get('state')).toBe('tx-1')
  const { payload } = await jwtVerify(location.searchParams.get('link_token') as string, SECRET, {
    algorithms: ['HS256'],
  })
  return payload
}

beforeEach(() => {
  post.mockReset()
})

describe('readAccountLinkSession', () => {
  it('names the missing claim so a malformed Action is diagnosable', () => {
    const { email: _email, ...noEmail } = SESSION_CLAIMS
    const { connection: _connection, ...noConnection } = SESSION_CLAIMS
    expect(() => readAccountLinkSession(SESSION_CLAIMS)).toThrow('carries no subject')
    expect(() => readAccountLinkSession({ sub: SOCIAL_USER_ID, ...noEmail })).toThrow('carries no email')
    expect(() => readAccountLinkSession({ sub: SOCIAL_USER_ID, ...noConnection })).toThrow('no database connection')
  })

  it('accepts a callback only at the one path this API serves it', () => {
    expect(() =>
      readAccountLinkSession({
        sub: SOCIAL_USER_ID,
        ...SESSION_CLAIMS,
        callback: 'https://api.dev.boxlite.ai/elsewhere',
      }),
    ).toThrow('no account link callback')
  })

  it('trims the address the second sign-in will be pinned to', () => {
    expect(readAccountLinkSession({ sub: SOCIAL_USER_ID, ...SESSION_CLAIMS, email: '  ada@example.com  ' })).toEqual({
      socialUserId: SOCIAL_USER_ID,
      email: 'ada@example.com',
      connection: DB_CONNECTION,
      callbackUrl: CALLBACK_URL,
    })
  })
})

describe('buildSecondAuthorizeUrl', () => {
  it('escapes an address whose plus sign would otherwise decode as a space', () => {
    const url = new URL(
      buildSecondAuthorizeUrl({
        authorizeUrl: `${TENANT}/authorize`,
        clientId: SPA_CLIENT,
        session: {
          socialUserId: SOCIAL_USER_ID,
          email: 'ada+boxlite@example.com',
          connection: DB_CONNECTION,
          callbackUrl: CALLBACK_URL,
        },
        state: 'state-value',
        codeChallenge: 'challenge',
        signUp: false,
      }),
    )

    expect(url.searchParams.get('login_hint')).toBe('ada+boxlite@example.com')
    expect(url.search).toContain('login_hint=ada%2Bboxlite%40example.com')
  })
})

describe('AccountLinkController.start', () => {
  it('is invisible on a deployment that has not enabled account linking', async () => {
    const { controller, response } = makeController({ 'oidc.accountLink.enabled': false })

    await expect(controller.start(await actionToken(), 'tx-1', response as any)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it('refuses a request Auth0 did not attach a transaction state to', async () => {
    const { controller, response } = makeController()

    await expect(controller.start(await actionToken(), undefined, response as any)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it.each([
    ['signed with another secret', () => actionToken(undefined, { secret: new TextEncoder().encode('other-secret') })],
    ['already expired', () => actionToken(undefined, { expiresIn: '-1s' })],
    ['carrying no email', () => actionToken({ connection: DB_CONNECTION, callback: CALLBACK_URL })],
    ['carrying no subject', () => actionToken(undefined, { subject: '' })],
    [
      'pointing the tenant somewhere else',
      () => actionToken({ ...SESSION_CLAIMS, callback: 'https://evil.example/x' }),
    ],
    ['not a token at all', async () => 'not-a-jwt'],
  ])('refuses a session token %s', async (_case, token) => {
    const { controller, response } = makeController()

    await expect(controller.start(await token(), 'tx-1', response as any)).rejects.toBeInstanceOf(BadRequestException)
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it('forces a fresh password sign-in through the dashboard client when the address has a password account', async () => {
    const { controller, response } = makeController()

    const url = await started(controller, response)

    expect(`${url.origin}${url.pathname}`).toBe(`${TENANT}/authorize`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: SPA_CLIENT,
      response_type: 'code',
      redirect_uri: CALLBACK_URL,
      connection: DB_CONNECTION,
      // Without prompt=login the tenant would answer from the cookie the social
      // login just set, and never ask for the password this flow exists to check.
      prompt: 'login',
      login_hint: 'ada@example.com',
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.has('screen_hint')).toBe(false)
  })

  it('opens the tenant sign-up when no password account holds the address', async () => {
    const { controller, auth0Management, response } = makeController()
    // The social identity itself holds the address, but it is not the database
    // connection, so it is no account to sign in to.
    auth0Management.usersByEmail.mockResolvedValue([
      {
        user_id: SOCIAL_USER_ID,
        identities: [{ provider: 'google-oauth2', user_id: '103', connection: 'google-oauth2' }],
      },
    ])

    expect((await started(controller, response)).searchParams.get('screen_hint')).toBe('signup')
  })

  it('carries nothing the browser can read in its state', async () => {
    const { controller, response } = makeController()

    const state = (await started(controller, response)).searchParams.get('state') as string

    // Five dot-separated parts is a JWE: the verifier and the social identity
    // travel encrypted, and even the shared secret itself cannot verify it as
    // a signed token.
    expect(state.split('.')).toHaveLength(5)
    await expect(jwtVerify(state, SECRET)).rejects.toThrow()
  })
})

describe('AccountLinkController.callback', () => {
  it('redeems the code with the verifier whose challenge went to the tenant, and links', async () => {
    const { controller, auth0Management, linkedIdentity, response } = makeController()
    const authorize = await started(controller, response)
    post.mockResolvedValue({ data: { id_token: await idToken() } })

    await controller.callback(authorize.searchParams.get('state')!, 'code-1', undefined, response as any)

    const [tokenUrl, body] = post.mock.calls[0]
    const exchange = Object.fromEntries(body as URLSearchParams)
    expect(tokenUrl).toBe(`${TENANT}/oauth/token`)
    expect(exchange).toMatchObject({
      grant_type: 'authorization_code',
      client_id: SPA_CLIENT,
      code: 'code-1',
      redirect_uri: CALLBACK_URL,
    })
    expect(exchange).not.toHaveProperty('client_secret')
    expect(createHash('sha256').update(exchange.code_verifier).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    )
    expect(auth0Management.linkIdentity).toHaveBeenCalledWith(PRIMARY_USER_ID, SOCIAL_USER_ID)
    expect(linkedIdentity.adopt).toHaveBeenCalledWith(PRIMARY_USER_ID, SOCIAL_USER_ID)
    expect(await continueClaims(response)).toMatchObject({
      state: 'tx-1',
      sub: SOCIAL_USER_ID,
      outcome: 'linked',
      primary_user_id: PRIMARY_USER_ID,
    })
  })

  it.each([
    ['holds another address', { email: 'someone-else@example.com' }],
    ['is not a database account', { sub: 'github|7' }],
    ['has an unverified address', { email_verified: false }],
    ['was issued to another client', { aud: 'some-other-client' }],
    ['was issued by another tenant', { iss: 'https://another-tenant.us.auth0.com/' }],
    ['has expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ])('refuses to link when the second sign-in %s', async (_case, claims) => {
    const { controller, auth0Management, linkedIdentity, response } = makeController()
    const authorize = await started(controller, response)
    post.mockResolvedValue({ data: { id_token: await idToken(claims) } })

    await controller.callback(authorize.searchParams.get('state')!, 'code-1', undefined, response as any)

    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
    expect(linkedIdentity.adopt).not.toHaveBeenCalled()
    expect(await continueClaims(response)).toMatchObject({ outcome: 'mismatch' })
  })

  it('trusts the tenant record over an ID token issued before the email Form verified the account', async () => {
    // An old password account that never verified its address is sent through
    // the email Form during the second sign-in. The Form marks it verified, but
    // the ID token can still carry the value from before.
    const { controller, auth0Management, response } = makeController()
    const authorize = await started(controller, response)
    post.mockResolvedValue({ data: { id_token: await idToken({ email_verified: false }) } })
    auth0Management.getUser.mockResolvedValue({
      user_id: PRIMARY_USER_ID,
      email: 'ada@example.com',
      email_verified: true,
    })

    await controller.callback(authorize.searchParams.get('state')!, 'code-1', undefined, response as any)

    expect(auth0Management.getUser).toHaveBeenCalledWith(PRIMARY_USER_ID)
    expect(auth0Management.linkIdentity).toHaveBeenCalledWith(PRIMARY_USER_ID, SOCIAL_USER_ID)
    expect(await continueClaims(response)).toMatchObject({ outcome: 'linked', primary_user_id: PRIMARY_USER_ID })
  })

  it('does not ask the tenant again when the ID token already says the address is verified', async () => {
    const { controller, auth0Management, response } = makeController()
    const authorize = await started(controller, response)
    post.mockResolvedValue({ data: { id_token: await idToken() } })

    await controller.callback(authorize.searchParams.get('state')!, 'code-1', undefined, response as any)

    expect(auth0Management.getUser).not.toHaveBeenCalled()
  })

  it('hands a cancelled sign-in back to the Action without exchanging anything', async () => {
    const { controller, auth0Management, response } = makeController()
    const authorize = await started(controller, response)

    await controller.callback(authorize.searchParams.get('state')!, undefined, 'access_denied', response as any)

    expect(post).not.toHaveBeenCalled()
    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
    expect(await continueClaims(response)).toMatchObject({ outcome: 'cancelled' })
  })

  it('does not link at the tenant when moving the local data fails', async () => {
    // The link is the step that cannot be taken back: once Auth0 folds the
    // identity in, later social logins skip this callback entirely, so data
    // left behind here would never be moved.
    const { controller, auth0Management, linkedIdentity, response } = makeController()
    const authorize = await started(controller, response)
    post.mockResolvedValue({ data: { id_token: await idToken() } })
    linkedIdentity.adopt.mockRejectedValue(new Error('deadlock detected'))

    await controller.callback(authorize.searchParams.get('state')!, 'code-1', undefined, response as any)

    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
    expect(await continueClaims(response)).toMatchObject({ outcome: 'failed' })
  })

  it('reports a link the tenant refused as a failure, leaving the moved data for the retry', async () => {
    const { controller, auth0Management, linkedIdentity, response } = makeController()
    const authorize = await started(controller, response)
    post.mockResolvedValue({ data: { id_token: await idToken() } })
    auth0Management.linkIdentity.mockRejectedValue(new Error('409 identity already linked'))

    await controller.callback(authorize.searchParams.get('state')!, 'code-1', undefined, response as any)

    // Unlinked, the next social login comes back through this flow, and moving
    // again is a no-op; the password account already holds the data meanwhile.
    expect(linkedIdentity.adopt).toHaveBeenCalledWith(PRIMARY_USER_ID, SOCIAL_USER_ID)
    const claims = await continueClaims(response)
    expect(claims).toMatchObject({ outcome: 'failed' })
    expect(claims).not.toHaveProperty('primary_user_id')
  })

  it.each([
    ['the Action’s session token', () => actionToken()],
    [
      'a state encrypted under another secret',
      async () => {
        const other = 'another-secret-of-32-characters!!'
        const { controller, response } = makeController({ 'oidc.accountLink.redirectSecret': other })
        const sessionToken = await actionToken(undefined, { secret: new TextEncoder().encode(other) })
        await controller.start(sessionToken, 'tx-1', response as any)
        return redirectedTo(response).searchParams.get('state')!
      },
    ],
  ])('refuses %s presented as its state', async (_case, state) => {
    const { controller, response } = makeController()

    await expect(controller.callback(await state(), 'code-1', undefined, response as any)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(post).not.toHaveBeenCalled()
    expect(response.redirect).not.toHaveBeenCalled()
  })
})
