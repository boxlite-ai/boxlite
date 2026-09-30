/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}))

import axios from 'axios'
import { SignJWT, jwtVerify } from 'jose'
import { AccountLinkService, LinkPageState, readAccountLinkSession } from './account-link.service'

const post = axios.post as jest.Mock

const REDIRECT_SECRET = 'redirect-secret-value-of-32-chars!'
const SECRET = new TextEncoder().encode(REDIRECT_SECRET)
const TENANT = 'https://tenant.us.auth0.com'
const PUBLIC_DOMAIN = 'https://auth.dev.boxlite.ai'
const DB_CONNECTION = 'Username-Password-Authentication'
const LINK_CLIENT = 'link-client'
const LINK_CLIENT_SECRET = 'link-client-secret'
const SOCIAL_USER_ID = 'google-oauth2|103'
const PRIMARY_USER_ID = 'auth0|primary'
const BROWSER_IP = '203.0.113.7'

const SESSION_CLAIMS = { email: 'ada@example.com', connection: DB_CONNECTION }

/** The state the password page posts, for an address that has a password account. */
const STATE: LinkPageState = {
  socialUserId: SOCIAL_USER_ID,
  email: 'ada@example.com',
  connection: DB_CONNECTION,
  transactionState: 'tx-1',
  signUp: false,
}

function makeService(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'oidc.accountLink.redirectSecret': REDIRECT_SECRET,
    'oidc.accountLink.passwordClientId': LINK_CLIENT,
    'oidc.accountLink.passwordClientSecret': LINK_CLIENT_SECRET,
    'oidc.accountLink.issuer': `${TENANT}/`,
    'oidc.accountLink.tokenUrl': `${TENANT}/oauth/token`,
    'oidc.accountLink.signupUrl': `${TENANT}/dbconnections/signup`,
    'oidc.accountLink.changePasswordUrl': `${TENANT}/dbconnections/change_password`,
    'oidc.accountLink.continueUrl': `${PUBLIC_DOMAIN}/continue`,
    ...overrides,
  }
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`account-link.service.spec: unexpected config key "${key}"`)
      return values[key]
    }),
  }
  const auth0Management = {
    linkIdentity: jest.fn().mockResolvedValue(undefined),
    markEmailVerified: jest.fn().mockResolvedValue(undefined),
  }
  const linkedIdentity = { adopt: jest.fn().mockResolvedValue(undefined) }
  const service = new AccountLinkService(configService as any, auth0Management as any, linkedIdentity as any)
  return { service, auth0Management, linkedIdentity }
}

function actionToken(
  claims: Record<string, unknown> = SESSION_CLAIMS,
  { subject = SOCIAL_USER_ID, expiresIn = '60s', secret = SECRET }: Partial<Record<string, any>> = {},
) {
  const token = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresIn)
  if (subject) token.setSubject(subject)
  return token.sign(secret)
}

/** An ID token the tenant's token endpoint would return for the password. */
function idToken(claims: Record<string, unknown> = {}) {
  const token = new SignJWT({
    iss: `${TENANT}/`,
    aud: LINK_CLIENT,
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

/** The token endpoint answering the password-realm grant. */
async function tokenEndpointAccepts(claims: Record<string, unknown> = {}) {
  post.mockResolvedValue({ status: 200, data: { id_token: await idToken(claims) } })
}

function tokenEndpointRefuses(status: number, data: Record<string, unknown>) {
  post.mockResolvedValue({ status, data })
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

  it('trims the address the password is asked for', () => {
    expect(readAccountLinkSession({ sub: SOCIAL_USER_ID, ...SESSION_CLAIMS, email: '  ada@example.com  ' })).toEqual({
      socialUserId: SOCIAL_USER_ID,
      email: 'ada@example.com',
      connection: DB_CONNECTION,
    })
  })
})

describe('AccountLinkService.readSession', () => {
  it('reads the session the Action signed', async () => {
    const { service } = makeService()

    await expect(service.readSession(await actionToken())).resolves.toEqual({
      socialUserId: SOCIAL_USER_ID,
      email: 'ada@example.com',
      connection: DB_CONNECTION,
    })
  })

  it.each([
    ['signed with another secret', () => actionToken(undefined, { secret: new TextEncoder().encode('other-secret') })],
    ['already expired', () => actionToken(undefined, { expiresIn: '-1s' })],
    ['carrying no email', () => actionToken({ connection: DB_CONNECTION })],
    ['carrying no subject', () => actionToken(undefined, { subject: '' })],
    ['not a token at all', async () => 'not-a-jwt'],
  ])('refuses a session token %s', async (_case, token) => {
    const { service } = makeService()

    await expect(service.readSession(await token())).rejects.toThrow()
  })
})

describe('AccountLinkService.continueUrl', () => {
  it('resumes the transaction with a linked outcome only the Action’s secret verifies', async () => {
    const { service } = makeService()

    const url = new URL(await service.continueUrl(STATE, { outcome: 'linked', primaryUserId: PRIMARY_USER_ID }))

    expect(`${url.origin}${url.pathname}`).toBe(`${PUBLIC_DOMAIN}/continue`)
    expect(url.searchParams.get('state')).toBe('tx-1')
    const { payload } = await jwtVerify(url.searchParams.get('link_token') as string, SECRET, { algorithms: ['HS256'] })
    expect(payload).toMatchObject({
      state: 'tx-1',
      sub: SOCIAL_USER_ID,
      // Auth0 lists iss as the application the redirect targets.
      iss: PUBLIC_DOMAIN,
      outcome: 'linked',
      primary_user_id: PRIMARY_USER_ID,
    })
  })

  it('names no primary account for an outcome that is not a link', async () => {
    const { service } = makeService()

    const url = new URL(await service.continueUrl(STATE, { outcome: 'failed' }))

    const { payload } = await jwtVerify(url.searchParams.get('link_token') as string, SECRET, { algorithms: ['HS256'] })
    expect(payload).toMatchObject({ outcome: 'failed' })
    expect(payload).not.toHaveProperty('primary_user_id')
  })
})

describe('AccountLinkService.submitPassword', () => {
  it('checks the password for the address in the state with the password-realm grant, then links', async () => {
    const { service, auth0Management, linkedIdentity } = makeService()
    await tokenEndpointAccepts()

    const attempt = await service.submitPassword(STATE, 'correct horse', BROWSER_IP)

    const [tokenUrl, body, options] = post.mock.calls[0]
    expect(tokenUrl).toBe(`${TENANT}/oauth/token`)
    expect(Object.fromEntries(body as URLSearchParams)).toEqual({
      grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
      realm: DB_CONNECTION,
      username: 'ada@example.com',
      password: 'correct horse',
      client_id: LINK_CLIENT,
      client_secret: LINK_CLIENT_SECRET,
      scope: 'openid email',
    })
    // Brute-force protection counts this attempt against the browser, not the API.
    expect(options.headers['auth0-forwarded-for']).toBe(BROWSER_IP)
    expect(linkedIdentity.adopt).toHaveBeenCalledWith(PRIMARY_USER_ID, SOCIAL_USER_ID)
    expect(auth0Management.linkIdentity).toHaveBeenCalledWith(PRIMARY_USER_ID, SOCIAL_USER_ID)
    expect(auth0Management.markEmailVerified).not.toHaveBeenCalled()
    expect(attempt).toEqual({ kind: 'finished', outcome: { outcome: 'linked', primaryUserId: PRIMARY_USER_ID } })
  })

  it('marks a password account verified when the password proves it and the social login proved the address', async () => {
    const { service, auth0Management } = makeService()
    await tokenEndpointAccepts({ email_verified: false })

    const attempt = await service.submitPassword(STATE, 'correct horse', BROWSER_IP)

    expect(auth0Management.markEmailVerified).toHaveBeenCalledWith(PRIMARY_USER_ID)
    expect(attempt).toEqual({ kind: 'finished', outcome: { outcome: 'linked', primaryUserId: PRIMARY_USER_ID } })
  })

  it('lets a wrong password be tried again', async () => {
    const { service, auth0Management } = makeService()
    tokenEndpointRefuses(403, { error: 'invalid_grant', error_description: 'Wrong email or password.' })

    await expect(service.submitPassword(STATE, 'wrong', BROWSER_IP)).resolves.toEqual({
      kind: 'refused',
      message: 'Wrong email or password.',
      retry: true,
    })
    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
  })

  it.each([
    [
      'multi-factor authentication',
      403,
      { error: 'mfa_required', error_description: 'Multifactor authentication required' },
    ],
    ['a blocked account', 429, { error: 'too_many_attempts', error_description: 'Your account has been blocked.' }],
  ])('offers no retry when %s stops the password', async (_case, status, refusal) => {
    const { service, auth0Management } = makeService()
    tokenEndpointRefuses(status, refusal)

    const attempt = await service.submitPassword(STATE, 'correct horse', BROWSER_IP)

    expect(attempt).toMatchObject({ kind: 'refused', retry: false })
    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
  })

  it('asks for the password again when none was typed, without asking Auth0', async () => {
    const { service } = makeService()

    await expect(service.submitPassword(STATE, '', BROWSER_IP)).resolves.toEqual({
      kind: 'refused',
      message: 'Enter the password.',
      retry: true,
    })
    expect(post).not.toHaveBeenCalled()
  })

  it.each([
    ['holds another address', { email: 'someone-else@example.com' }],
    ['is not a database account', { sub: 'github|7' }],
    ['was issued to another client', { aud: 'some-other-client' }],
    ['was issued by another tenant', { iss: 'https://another-tenant.us.auth0.com/' }],
    ['has expired', { exp: Math.floor(Date.now() / 1000) - 60 }],
  ])('refuses to link when the ID token %s', async (_case, claims) => {
    const { service, auth0Management, linkedIdentity } = makeService()
    await tokenEndpointAccepts(claims)

    const attempt = await service.submitPassword(STATE, 'correct horse', BROWSER_IP)

    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
    expect(linkedIdentity.adopt).not.toHaveBeenCalled()
    expect(attempt).toEqual({ kind: 'finished', outcome: { outcome: 'mismatch' } })
  })

  it('signs up the address with the new password when it has no password account, then links', async () => {
    const { service, auth0Management, linkedIdentity } = makeService()
    post.mockResolvedValue({ status: 200, data: { _id: 'new-account', email: 'ada@example.com' } })

    const attempt = await service.submitPassword({ ...STATE, signUp: true }, 'a new password', BROWSER_IP)

    expect(post).toHaveBeenCalledWith(
      `${TENANT}/dbconnections/signup`,
      { client_id: LINK_CLIENT, email: 'ada@example.com', password: 'a new password', connection: DB_CONNECTION },
      expect.anything(),
    )
    expect(auth0Management.markEmailVerified).toHaveBeenCalledWith('auth0|new-account')
    expect(linkedIdentity.adopt).toHaveBeenCalledWith('auth0|new-account', SOCIAL_USER_ID)
    expect(attempt).toEqual({ kind: 'finished', outcome: { outcome: 'linked', primaryUserId: 'auth0|new-account' } })
  })

  it('returns the password policy when a new password is too weak', async () => {
    const { service, auth0Management } = makeService()
    post.mockResolvedValue({
      status: 400,
      data: {
        name: 'PasswordStrengthError',
        code: 'invalid_password',
        message: 'Password is too weak',
        policy: '* At least 8 characters in length',
      },
    })

    await expect(service.submitPassword({ ...STATE, signUp: true }, 'short', BROWSER_IP)).resolves.toEqual({
      kind: 'refused',
      message: 'Password is too weak\n* At least 8 characters in length',
      retry: true,
    })
    expect(auth0Management.markEmailVerified).not.toHaveBeenCalled()
  })

  it('does not link at the tenant when moving the local data fails', async () => {
    // The link is the step that cannot be taken back: once Auth0 folds the
    // identity in, later social logins skip this page entirely, so data left
    // behind here would never be moved.
    const { service, auth0Management, linkedIdentity } = makeService()
    await tokenEndpointAccepts()
    linkedIdentity.adopt.mockRejectedValue(new Error('deadlock detected'))

    const attempt = await service.submitPassword(STATE, 'correct horse', BROWSER_IP)

    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
    expect(attempt).toEqual({ kind: 'finished', outcome: { outcome: 'failed' } })
  })

  it('reports a link the tenant refused as a failure, leaving the moved data for the retry', async () => {
    const { service, auth0Management, linkedIdentity } = makeService()
    await tokenEndpointAccepts()
    auth0Management.linkIdentity.mockRejectedValue(new Error('409 identity already linked'))

    const attempt = await service.submitPassword(STATE, 'correct horse', BROWSER_IP)

    expect(linkedIdentity.adopt).toHaveBeenCalledWith(PRIMARY_USER_ID, SOCIAL_USER_ID)
    expect(attempt).toEqual({ kind: 'finished', outcome: { outcome: 'failed' } })
  })
})

describe('AccountLinkService.requestPasswordReset', () => {
  it('asks Auth0 to email a reset link to the address in the state', async () => {
    const { service } = makeService()
    post.mockResolvedValue({ status: 200, data: "We've just sent you an email to reset your password." })

    await service.requestPasswordReset(STATE)

    expect(post).toHaveBeenCalledWith(
      `${TENANT}/dbconnections/change_password`,
      { client_id: LINK_CLIENT, email: 'ada@example.com', connection: DB_CONNECTION },
      expect.anything(),
    )
  })
})
