/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}))

import { BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { SignJWT, jwtVerify } from 'jose'
import { AccountLinkController } from './account-link.controller'
import { AccountLinkService } from './account-link.service'

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

function makeController(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'oidc.accountLink.enabled': true,
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
    markEmailVerified: jest.fn().mockResolvedValue(undefined),
  }
  const linkedIdentity = { adopt: jest.fn().mockResolvedValue(undefined) }
  const service = new AccountLinkService(configService as any, auth0Management as any, linkedIdentity as any)
  const response: any = { redirect: jest.fn(), send: jest.fn() }
  for (const method of ['status', 'set', 'type']) response[method] = jest.fn(() => response)
  return {
    controller: new AccountLinkController(configService as any, service),
    service,
    auth0Management,
    response,
  }
}

const request = { ips: [] as string[], ip: BROWSER_IP } as any

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

/** The page the controller sent, with the state its form posts back. */
function renderedPage(response: { send: jest.Mock }) {
  expect(response.send).toHaveBeenCalledTimes(1)
  const html = response.send.mock.calls[0][0] as string
  const state = html.match(/name="state" value="([^"]*)"/)?.[1]
  if (state === undefined) throw new Error('account-link.controller.spec: the page carries no state')
  response.send.mockClear()
  return { html, state }
}

/** The state the password page posts, as the service mints it for the session. */
async function pageState(service: AccountLinkService, email = 'ada@example.com') {
  const { token } = await service.beginLink({ socialUserId: SOCIAL_USER_ID, email, connection: DB_CONNECTION }, 'tx-1')
  return token
}

/** The claims of the token the password step carried back to `/continue`. */
async function resumedClaims(response: { redirect: jest.Mock }) {
  expect(response.redirect).toHaveBeenCalledTimes(1)
  const [status, location] = response.redirect.mock.calls[0]
  expect(status).toBe(303)
  const url = new URL(location)
  expect(`${url.origin}${url.pathname}`).toBe(`${PUBLIC_DOMAIN}/continue`)
  expect(url.searchParams.get('state')).toBe('tx-1')
  const { payload } = await jwtVerify(url.searchParams.get('link_token') as string, SECRET, { algorithms: ['HS256'] })
  return payload
}

beforeEach(() => {
  post.mockReset()
})

describe('AccountLinkController.start', () => {
  it('is invisible on a deployment that has not enabled account linking', async () => {
    const { controller, response } = makeController({ 'oidc.accountLink.enabled': false })

    await expect(controller.start(await actionToken(), 'tx-1', response as any)).rejects.toBeInstanceOf(
      NotFoundException,
    )
    expect(response.send).not.toHaveBeenCalled()
  })

  it('refuses a request Auth0 did not attach a transaction state to', async () => {
    const { controller, response } = makeController()

    await expect(controller.start(await actionToken(), undefined, response as any)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(response.send).not.toHaveBeenCalled()
  })

  it.each([
    ['signed with another secret', () => actionToken(undefined, { secret: new TextEncoder().encode('other-secret') })],
    ['already expired', () => actionToken(undefined, { expiresIn: '-1s' })],
    ['carrying no email', () => actionToken({ connection: DB_CONNECTION })],
    ['carrying no subject', () => actionToken(undefined, { subject: '' })],
    ['not a token at all', async () => 'not-a-jwt'],
  ])('refuses a session token %s', async (_case, token) => {
    const { controller, response } = makeController()

    await expect(controller.start(await token(), 'tx-1', response as any)).rejects.toBeInstanceOf(BadRequestException)
    expect(response.send).not.toHaveBeenCalled()
  })

  it('asks for the password of the account that holds the address, which it shows but never lets change', async () => {
    const { controller, response } = makeController()

    await controller.start(await actionToken(), 'tx-1', response as any)

    const { html } = renderedPage(response)
    expect(html).toContain('Link your Google sign-in')
    expect(html).toContain('<strong>ada@example.com</strong> already has a BoxLite account')
    expect(html).toMatch(/<input id="email" name="username" type="email" value="ada@example.com" [^>]*readonly>/)
    expect(html).toContain('autocomplete="current-password"')
    expect(html).toContain('Forgot password?')
    // The form posts only here, and the redirect after it only to /continue;
    // nothing on the page runs, frames it, or leaks the URL as a referrer.
    expect(response.set).toHaveBeenCalledWith({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${PUBLIC_DOMAIN}; base-uri 'none'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
    })
  })

  it('asks for a new password when no password account holds the address', async () => {
    const { controller, auth0Management, response } = makeController()
    // The social identity itself holds the address, but it is not the database
    // connection, so it is no account to prove.
    auth0Management.usersByEmail.mockResolvedValue([
      {
        user_id: SOCIAL_USER_ID,
        identities: [{ provider: 'google-oauth2', user_id: '103', connection: 'google-oauth2' }],
      },
    ])

    await controller.start(await actionToken(), 'tx-1', response as any)

    const { html } = renderedPage(response)
    expect(html).toContain('Choose one for <strong>ada@example.com</strong>')
    expect(html).toContain('autocomplete="new-password"')
    expect(html).not.toContain('Forgot password?')
  })

  it('shows the address as text, never as markup', async () => {
    const { controller, response } = makeController()

    await controller.start(
      await actionToken({ ...SESSION_CLAIMS, email: '"><img src=x onerror=alert(1)>@example.com' }),
      'tx-1',
      response as any,
    )

    const { html } = renderedPage(response)
    expect(html).not.toContain('<img')
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;@example.com')
  })

  it('carries nothing the browser can read in its state', async () => {
    const { controller, response } = makeController()

    await controller.start(await actionToken(), 'tx-1', response as any)
    const { state } = renderedPage(response)

    // Five dot-separated parts is a JWE: even the shared secret itself cannot
    // verify it as a signed token.
    expect(state.split('.')).toHaveLength(5)
    await expect(jwtVerify(state, SECRET)).rejects.toThrow()
  })
})

describe('AccountLinkController.password', () => {
  it('checks the password of the account in the state, links, and resumes the login with the outcome', async () => {
    const { controller, service, auth0Management, response } = makeController()
    const state = await pageState(service)
    await tokenEndpointAccepts()

    await controller.password({ state, password: 'correct horse', intent: 'link' }, request, response as any)

    // Brute-force protection counts this attempt against the browser, not the API.
    expect(post.mock.calls[0][2].headers['auth0-forwarded-for']).toBe(BROWSER_IP)
    expect(auth0Management.linkIdentity).toHaveBeenCalledWith(PRIMARY_USER_ID, SOCIAL_USER_ID)
    expect(await resumedClaims(response)).toMatchObject({
      state: 'tx-1',
      sub: SOCIAL_USER_ID,
      outcome: 'linked',
      primary_user_id: PRIMARY_USER_ID,
    })
  })

  it('never takes the address from the form', async () => {
    const { controller, service, response } = makeController()
    const state = await pageState(service)
    await tokenEndpointAccepts()

    await controller.password(
      { state, username: 'someone-else@example.com', password: 'correct horse', intent: 'link' },
      request,
      response as any,
    )

    expect((post.mock.calls[0][1] as URLSearchParams).get('username')).toBe('ada@example.com')
  })

  it('shows the page again with the reason when the password is wrong', async () => {
    const { controller, service, auth0Management, response } = makeController()
    const state = await pageState(service)
    tokenEndpointRefuses(403, { error: 'invalid_grant', error_description: 'Wrong email or password.' })

    await controller.password({ state, password: 'wrong', intent: 'link' }, request, response as any)

    const page = renderedPage(response)
    expect(page.html).toContain('<p class="error" role="alert">Wrong email or password.</p>')
    expect(page.html).toContain('id="password"')
    expect(page.state).toBe(state)
    expect(response.redirect).not.toHaveBeenCalled()
    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
  })

  it.each([
    [
      'multi-factor authentication',
      { error: 'mfa_required', error_description: 'Multifactor authentication required' },
      'multi-factor authentication',
    ],
    [
      'a blocked account',
      { error: 'too_many_attempts', error_description: 'Your account has been blocked.' },
      'Your account has been blocked.',
    ],
  ])('offers only Cancel when %s stops the password', async (_case, refusal, shown) => {
    const { controller, service, auth0Management, response } = makeController()
    const state = await pageState(service)
    tokenEndpointRefuses(refusal.error === 'too_many_attempts' ? 429 : 403, refusal)

    await controller.password({ state, password: 'correct horse', intent: 'link' }, request, response as any)

    const { html } = renderedPage(response)
    expect(html).toContain(shown)
    expect(html).not.toContain('id="password"')
    expect(html).toContain('id="cancel"')
    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
  })

  it('asks for the password again when none was typed, without asking Auth0', async () => {
    const { controller, service, response } = makeController()
    const state = await pageState(service)

    await controller.password({ state, password: '', intent: 'link' }, request, response as any)

    expect(renderedPage(response).html).toContain('Enter the password.')
    expect(post).not.toHaveBeenCalled()
  })

  it('hands a password account holding another address back to the Action as a mismatch', async () => {
    const { controller, service, auth0Management, response } = makeController()
    const state = await pageState(service)
    await tokenEndpointAccepts({ email: 'someone-else@example.com' })

    await controller.password({ state, password: 'correct horse', intent: 'link' }, request, response as any)

    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
    expect(await resumedClaims(response)).toMatchObject({ outcome: 'mismatch' })
  })

  it('signs up the address when the page was opened for one with no password account, then links', async () => {
    const { controller, service, auth0Management, response } = makeController()
    auth0Management.usersByEmail.mockResolvedValue([])
    const state = await pageState(service)
    post.mockResolvedValue({ status: 200, data: { _id: 'new-account', email: 'ada@example.com' } })

    await controller.password({ state, password: 'a new password', intent: 'link' }, request, response as any)

    expect(post.mock.calls[0][0]).toBe(`${TENANT}/dbconnections/signup`)
    expect(await resumedClaims(response)).toMatchObject({ outcome: 'linked', primary_user_id: 'auth0|new-account' })
  })

  it('shows the password policy again when a new password is too weak', async () => {
    const { controller, service, auth0Management, response } = makeController()
    auth0Management.usersByEmail.mockResolvedValue([])
    const state = await pageState(service)
    post.mockResolvedValue({
      status: 400,
      data: {
        name: 'PasswordStrengthError',
        code: 'invalid_password',
        message: 'Password is too weak',
        policy: '* At least 8 characters in length',
      },
    })

    await controller.password({ state, password: 'short', intent: 'link' }, request, response as any)

    const { html } = renderedPage(response)
    expect(html).toContain('Password is too weak\n* At least 8 characters in length')
    expect(html).toContain('id="password"')
  })

  it('hands a cancelled link back to the Action without asking Auth0 anything', async () => {
    const { controller, service, auth0Management, response } = makeController()
    const state = await pageState(service)

    await controller.password({ state, intent: 'cancel' }, request, response as any)

    expect(post).not.toHaveBeenCalled()
    expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
    expect(await resumedClaims(response)).toMatchObject({ outcome: 'cancelled' })
  })

  it('asks Auth0 to email a reset link to the address in the state, and keeps the page', async () => {
    const { controller, service, response } = makeController()
    const state = await pageState(service)
    post.mockResolvedValue({ status: 200, data: "We've just sent you an email to reset your password." })

    await controller.password(
      { state, username: 'someone-else@example.com', intent: 'reset' },
      request,
      response as any,
    )

    expect(post).toHaveBeenCalledWith(
      `${TENANT}/dbconnections/change_password`,
      { client_id: LINK_CLIENT, email: 'ada@example.com', connection: DB_CONNECTION },
      expect.anything(),
    )
    const page = renderedPage(response)
    expect(page.html).toContain('A password reset link is on its way to ada@example.com.')
    expect(page.state).toBe(state)
    expect(response.redirect).not.toHaveBeenCalled()
  })

  it.each([
    ['the Action’s session token', () => actionToken()],
    [
      'a state encrypted under another secret',
      async () => {
        const { service } = makeController({ 'oidc.accountLink.redirectSecret': 'another-secret-of-32-characters!!' })
        return pageState(service)
      },
    ],
  ])('refuses %s presented as its state', async (_case, state) => {
    const { controller, service, response } = makeController()

    await expect(
      controller.password(
        { state: await state(), password: 'correct horse', intent: 'link' },
        request,
        response as any,
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(post).not.toHaveBeenCalled()
    expect(response.redirect).not.toHaveBeenCalled()
  })
})
