/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SignJWT, jwtVerify } from 'jose'
import { AccountLinkService, readAccountLinkSession } from './account-link.service'

const REDIRECT_SECRET = 'redirect-secret-value-of-32-chars!'
const SECRET = new TextEncoder().encode(REDIRECT_SECRET)
const PUBLIC_DOMAIN = 'https://auth.dev.boxlite.ai'
const DB_CONNECTION = 'Username-Password-Authentication'
const SOCIAL_USER_ID = 'google-oauth2|103'
const PRIMARY_USER_ID = 'auth0|primary'

const SESSION_CLAIMS = { email: 'ada@example.com', connection: DB_CONNECTION }

/** The login the outcome answers. */
const STATE = { socialUserId: SOCIAL_USER_ID, transactionState: 'tx-1' }

function makeService() {
  const values: Record<string, unknown> = {
    'oidc.accountLink.redirectSecret': REDIRECT_SECRET,
    'oidc.accountLink.continueUrl': `${PUBLIC_DOMAIN}/continue`,
  }
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`account-link.service.spec: unexpected config key "${key}"`)
      return values[key]
    }),
  }
  return { service: new AccountLinkService(configService as any) }
}

function actionToken(
  claims: Record<string, unknown> = SESSION_CLAIMS,
  { subject = SOCIAL_USER_ID, expiresIn = '60s', secret = SECRET }: Partial<Record<string, any>> = {},
) {
  const token = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(expiresIn)
  if (subject) token.setSubject(subject)
  return token.sign(secret)
}

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
