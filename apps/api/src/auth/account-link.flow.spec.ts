/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The whole login-time account link, with the real Post-Login Action and the
 * real API controller talking to each other.
 *
 * Each side has its own unit tests; what only this can catch is a break in the
 * contract between them — a token claim one side writes and the other does not
 * read, a query parameter under two names, the Auth0 transaction state lost on
 * the way round. Auth0 itself is played by `FakeTenant`, which does what its
 * documentation says the tenant does between the hops: `encodeToken` signs
 * HS256 with `sub` set to the user and the payload at the top level, the
 * redirect gains a `state`, and `validateToken` requires a `state` claim equal
 * to that transaction's.
 * https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/login-trigger/redirect-with-actions
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import axios from 'axios'
import { SignJWT, jwtVerify } from 'jose'
import { AccountLinkController } from './account-link.controller'
import { AccountLinkService } from './account-link.service'

const post = axios.post as jest.Mock

const SECRET = 'a-shared-secret-of-at-least-32-chars'
const SPA_CLIENT = 'spa_123'
const DB_CONNECTION = 'boxlite-users'
const FORM_ID = 'ap_verify'
const API = 'https://api.dev.example.com'
const TENANT = 'https://auth.dev.example.com'
const START_URL = `${API}/api/auth/link/start`
const CALLBACK_URL = `${API}/api/auth/link/callback`
const PRIMARY = 'auth0|primary'
const SOCIAL = 'google-oauth2|103'
const EMAIL = 'ada@example.com'

type Handler = (event: any, api: any) => Promise<void>

/** login-policy.js as the bootstrap tool would deploy it for this tenant. */
function deployedAction(): { onExecutePostLogin: Handler; onContinuePostLogin: Handler } {
  const source = readFileSync(join(__dirname, '../../../infra/bootstrap/auth0/login-policy.js'), 'utf8')
    .replace('__BOXLITE_CLIENT_ID_JSON__', JSON.stringify(SPA_CLIENT))
    .replace('__BOXLITE_DB_CONNECTION_JSON__', JSON.stringify(DB_CONNECTION))
    .replace('__EMAIL_VERIFICATION_FORM_ID_JSON__', JSON.stringify(FORM_ID))
    .replace('__ACCOUNT_LINK_API_ORIGIN_JSON__', JSON.stringify(API))
  expect(source).not.toMatch(/__[A-Z_]+_JSON__/)
  const exports: Record<string, Handler> = {}
  runInNewContext(source, { exports })
  return exports as { onExecutePostLogin: Handler; onContinuePostLogin: Handler }
}

/** Where one pass of the Action left the transaction. */
interface Outcome {
  redirect?: URL
  rendered?: string
  denied?: string
  primaryUser?: string
  claims: Record<string, unknown>
}

class FakeTenant {
  private readonly action = deployedAction()
  private readonly key = new TextEncoder().encode(SECRET)
  readonly transactionState = 'auth0-transaction-state'

  constructor(private readonly user: Record<string, unknown>) {}

  private event(query: Record<string, string> = {}, prompt?: { id: string }) {
    return {
      authorization: {},
      client: { client_id: SPA_CLIENT },
      connection: { name: 'google-oauth2', strategy: 'google-oauth2' },
      secrets: { ACCOUNT_LINK_SECRET: SECRET },
      transaction: { protocol: 'oidc-basic-profile' },
      request: { query },
      user: this.user,
      ...(prompt && { prompt }),
    }
  }

  private async run(handler: Handler, event: object): Promise<Outcome> {
    const outcome: Outcome = { claims: {} }
    const pending: Promise<unknown>[] = []
    let sessionToken: Promise<string> | undefined
    const api = {
      access: { deny: (reason: string) => (outcome.denied = reason) },
      accessToken: { setCustomClaim: (name: string, value: unknown) => (outcome.claims[name] = value) },
      prompt: { render: (id: string) => (outcome.rendered = id) },
      authentication: { setPrimaryUser: (id: string) => (outcome.primaryUser = id) },
      redirect: {
        encodeToken: (options: { secret: string; expiresInSeconds: number; payload: Record<string, unknown> }) => {
          sessionToken = new SignJWT({ ...options.payload })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject(String(this.user.user_id))
            .setIssuer(new URL(TENANT).hostname)
            .setIssuedAt()
            .setExpirationTime(`${options.expiresInSeconds}s`)
            .sign(new TextEncoder().encode(options.secret))
          // The Action uses the value synchronously; the harness resolves it below.
          return '__session_token__'
        },
        sendUserTo: (url: string, options: { query: Record<string, string> }) => {
          pending.push(
            (async () => {
              const redirect = new URL(url)
              for (const [name, value] of Object.entries(options.query)) {
                redirect.searchParams.set(name, value === '__session_token__' ? await sessionToken! : value)
              }
              redirect.searchParams.set('state', this.transactionState)
              outcome.redirect = redirect
            })(),
          )
        },
        validateToken: (options: { secret: string; tokenParameterName: string }) => {
          throw Object.assign(new Error('validateToken is resolved by the harness'), { options })
        },
      },
    }
    await handler(event, api)
    await Promise.all(pending)
    return outcome
  }

  /** The social login arriving at the Action. */
  login(): Promise<Outcome> {
    return this.run(this.action.onExecutePostLogin, this.event())
  }

  /** The email Form handing the transaction back. */
  formCompleted(): Promise<Outcome> {
    return this.run(this.action.onContinuePostLogin, this.event({}, { id: FORM_ID }))
  }

  /**
   * The browser arriving at `/continue`: the Action resumes, and the tenant
   * validates the token it names before handing over the payload.
   */
  async continue(url: URL): Promise<Outcome> {
    expect(`${url.origin}${url.pathname}`).toBe(`${TENANT}/continue`)
    const query = Object.fromEntries(url.searchParams)
    expect(query.state).toBe(this.transactionState)
    // validateToken is synchronous in Auth0, so the harness verifies first and
    // hands the Action the resulting payload, or the error it would have seen.
    let verified: Record<string, unknown> | Error
    try {
      const { payload } = await jwtVerify(query.link_token ?? '', this.key, { algorithms: ['HS256'] })
      if (payload.state !== this.transactionState) throw new Error('state claim does not match the transaction')
      verified = payload
    } catch (error) {
      verified = error as Error
    }
    const event = this.event(query)
    const outcome: Outcome = { claims: {} }
    await this.action.onContinuePostLogin(event, {
      access: { deny: (reason: string) => (outcome.denied = reason) },
      accessToken: { setCustomClaim: (name: string, value: unknown) => (outcome.claims[name] = value) },
      authentication: { setPrimaryUser: (id: string) => (outcome.primaryUser = id) },
      redirect: {
        validateToken: (options: { secret: string; tokenParameterName: string }) => {
          expect(options).toEqual({ secret: SECRET, tokenParameterName: 'link_token' })
          if (verified instanceof Error) throw verified
          return verified
        },
      },
    })
    return outcome
  }
}

function api(databaseAccount: boolean) {
  const values: Record<string, unknown> = {
    'oidc.accountLink.enabled': true,
    'oidc.accountLink.redirectSecret': SECRET,
    'oidc.accountLink.clientId': SPA_CLIENT,
    'oidc.accountLink.issuer': `${TENANT}/`,
    'oidc.accountLink.authorizeUrl': `${TENANT}/authorize`,
    'oidc.accountLink.tokenUrl': `${TENANT}/oauth/token`,
    'oidc.accountLink.continueUrl': `${TENANT}/continue`,
  }
  const configService = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error(`account-link.flow.spec: unexpected config key "${key}"`)
      return values[key]
    },
  }
  const auth0Management = {
    usersByEmail: jest
      .fn()
      .mockResolvedValue(
        databaseAccount
          ? [{ user_id: PRIMARY, identities: [{ provider: 'auth0', user_id: 'primary', connection: DB_CONNECTION }] }]
          : [],
      ),
    linkIdentity: jest.fn().mockResolvedValue(undefined),
  }
  const linkedIdentity = { adopt: jest.fn().mockResolvedValue(undefined) }
  const controller = new AccountLinkController(
    configService as any,
    new AccountLinkService(configService as any, auth0Management as any, linkedIdentity as any),
  )
  return { controller, auth0Management, linkedIdentity }
}

/** Drive one controller method and hand back where it redirected. */
async function redirectOf(call: (res: any) => Promise<void>): Promise<URL> {
  const res = { redirect: jest.fn() }
  await call(res)
  expect(res.redirect).toHaveBeenCalledTimes(1)
  expect(res.redirect.mock.calls[0][0]).toBe(302)
  return new URL(res.redirect.mock.calls[0][1])
}

/** The tenant answering the code exchange for whoever typed the password. */
function tokenEndpointAnswers(claims: Record<string, unknown>) {
  post.mockImplementation(async (url: string, body: URLSearchParams) => {
    expect(url).toBe(`${TENANT}/oauth/token`)
    // The dashboard client is public: the code is redeemed with PKCE, the
    // callback is the one the Action named, and no client secret exists.
    expect(body.get('redirect_uri')).toBe(CALLBACK_URL)
    expect(body.get('code_verifier')).toBeTruthy()
    expect(body.has('client_secret')).toBe(false)
    const idToken = await new SignJWT({ iss: `${TENANT}/`, aud: SPA_CLIENT, email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('tenant-signing-key'))
    return { data: { id_token: idToken } }
  })
}

beforeEach(() => post.mockReset())

const socialUser = { user_id: SOCIAL, email: EMAIL, email_verified: true, name: 'Ada' }

it('links a first social login into the password account, and the token names that account', async () => {
  const tenant = new FakeTenant(socialUser)
  const { controller, auth0Management, linkedIdentity } = api(true)

  const toApi = (await tenant.login()).redirect!
  expect(`${toApi.origin}${toApi.pathname}`).toBe(START_URL)

  const toAuthorize = await redirectOf((res) =>
    controller.start(toApi.searchParams.get('session_token')!, toApi.searchParams.get('state')!, res),
  )
  expect(toAuthorize.searchParams.get('prompt')).toBe('login')
  expect(toAuthorize.searchParams.get('login_hint')).toBe(EMAIL)

  // The person enters the password of the account that owns the address.
  tokenEndpointAnswers({ sub: PRIMARY, email: EMAIL })
  const toContinue = await redirectOf((res) =>
    controller.callback(toAuthorize.searchParams.get('state')!, 'authorization-code', undefined, res),
  )

  const finished = await tenant.continue(toContinue)

  expect(auth0Management.linkIdentity).toHaveBeenCalledWith(PRIMARY, SOCIAL)
  expect(linkedIdentity.adopt).toHaveBeenCalledWith(PRIMARY, SOCIAL)
  expect(finished).toEqual({ primaryUser: PRIMARY, claims: { email_verified: true, email: EMAIL, name: 'Ada' } })
})

it('sends an address with no password account to the tenant sign-up, then links the new account', async () => {
  const tenant = new FakeTenant(socialUser)
  const { controller } = api(false)

  const toApi = (await tenant.login()).redirect!
  const toAuthorize = await redirectOf((res) =>
    controller.start(toApi.searchParams.get('session_token')!, toApi.searchParams.get('state')!, res),
  )
  expect(toAuthorize.searchParams.get('screen_hint')).toBe('signup')

  tokenEndpointAnswers({ sub: 'auth0|new-account', email: EMAIL })
  const toContinue = await redirectOf((res) =>
    controller.callback(toAuthorize.searchParams.get('state')!, 'authorization-code', undefined, res),
  )

  expect((await tenant.continue(toContinue)).primaryUser).toBe('auth0|new-account')
})

it('proves an unverified GitHub address with the email Form before anything else', async () => {
  const tenant = new FakeTenant({ user_id: 'github|7', email: EMAIL, email_verified: false, name: 'Ada' })
  const { controller } = api(true)

  const first = await tenant.login()
  expect(first).toMatchObject({ rendered: FORM_ID })
  expect(first.redirect).toBeUndefined()

  const toApi = (await tenant.formCompleted()).redirect!
  const toAuthorize = await redirectOf((res) =>
    controller.start(toApi.searchParams.get('session_token')!, toApi.searchParams.get('state')!, res),
  )
  tokenEndpointAnswers({ sub: PRIMARY, email: EMAIL })
  const toContinue = await redirectOf((res) =>
    controller.callback(toAuthorize.searchParams.get('state')!, 'authorization-code', undefined, res),
  )

  expect((await tenant.continue(toContinue)).primaryUser).toBe(PRIMARY)
})

it('issues no token when the password typed belongs to another account', async () => {
  const tenant = new FakeTenant(socialUser)
  const { controller, auth0Management } = api(true)

  const toApi = (await tenant.login()).redirect!
  const toAuthorize = await redirectOf((res) =>
    controller.start(toApi.searchParams.get('session_token')!, toApi.searchParams.get('state')!, res),
  )
  tokenEndpointAnswers({ sub: 'auth0|someone-else', email: 'mallory@example.com' })
  const toContinue = await redirectOf((res) =>
    controller.callback(toAuthorize.searchParams.get('state')!, 'authorization-code', undefined, res),
  )

  const finished = await tenant.continue(toContinue)
  expect(auth0Management.linkIdentity).not.toHaveBeenCalled()
  expect(finished.primaryUser).toBeUndefined()
  expect(finished.denied).toMatch(/does not hold the address/)
})

it('issues no token when the person backs out of the password page', async () => {
  const tenant = new FakeTenant(socialUser)
  const { controller } = api(true)

  const toApi = (await tenant.login()).redirect!
  const toAuthorize = await redirectOf((res) =>
    controller.start(toApi.searchParams.get('session_token')!, toApi.searchParams.get('state')!, res),
  )
  const toContinue = await redirectOf((res) =>
    controller.callback(toAuthorize.searchParams.get('state')!, undefined, 'access_denied', res),
  )

  const finished = await tenant.continue(toContinue)
  expect(finished.primaryUser).toBeUndefined()
  expect(finished.denied).toMatch(/did not complete/)
})
