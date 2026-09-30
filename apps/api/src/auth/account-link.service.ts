/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { JWTPayload, SignJWT, decodeJwt, jwtVerify } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'
import { Auth0ManagementService } from '../user/auth0-management.service'
import { LinkedIdentityService } from '../user/linked-identity.service'

/**
 * What the Post-Login Action hands over when it interrupts a social login
 * (POL-555): who is signing in, the address they now have to prove a password
 * for, and — from the value the tenant configurator deployed — which database
 * connection holds that password.
 */
export interface AccountLinkSession {
  socialUserId: string
  email: string
  connection: string
}

/** The session carried through the password page. */
export interface LinkPageState extends AccountLinkSession {
  transactionState: string
  /** No password account holds the address yet, so the page sets one. */
  signUp: boolean
}

/**
 * How the link ended, as the Action reads it on `/continue`.
 *
 * Every outcome goes back to the tenant, the failures included: a browser left
 * on this API mid-login would strand the Auth0 transaction, whereas the Action
 * can deny it with a message the login page shows.
 */
export type AccountLinkOutcome =
  | { outcome: 'linked'; primaryUserId: string }
  | { outcome: 'cancelled' }
  | { outcome: 'mismatch' }
  | { outcome: 'failed' }

/**
 * What one submission of the password page came to: the link is over, one way
 * or another, or the page is shown again with Auth0's reason — with the
 * password field when another try can help, without it when it cannot.
 */
export type PasswordAttempt =
  | { kind: 'finished'; outcome: AccountLinkOutcome }
  | { kind: 'refused'; message: string; retry: boolean }

/**
 * How long the token carried back to `/continue` stays acceptable. The browser
 * follows that redirect immediately, so this only has to outlast one hop.
 */
const CONTINUE_TOKEN_TTL_SECONDS = 60

// https://auth0.com/docs/get-started/authentication-and-authorization-flow/resource-owner-password-flow/call-your-api-using-resource-owner-password-flow
const PASSWORD_REALM_GRANT = 'http://auth0.com/oauth/grant-type/password-realm'

const MFA_REFUSAL =
  'This account uses multi-factor authentication, which linking at sign-in does not support yet. ' +
  'Cancel, then sign in with the password instead.'

/**
 * Read the claims the Action signed.
 *
 * Read strictly: this payload decides which address the page asks a password
 * for, so a missing or oddly-typed claim has to stop the flow rather than
 * show a half-specified page.
 */
export function readAccountLinkSession(payload: JWTPayload): AccountLinkSession {
  const { sub: socialUserId, email, connection } = payload
  if (typeof socialUserId !== 'string' || socialUserId.trim() === '') {
    throw new Error('session token carries no subject')
  }
  if (typeof email !== 'string' || email.trim() === '') {
    throw new Error('session token carries no email')
  }
  if (typeof connection !== 'string' || connection.trim() === '') {
    throw new Error('session token carries no database connection')
  }
  return { socialUserId, email: email.trim(), connection }
}

/**
 * The login-time account link on the API side: every token it mints or
 * accepts, and every call it makes to the tenant.
 *
 * One secret keys the tokens. The two Auth0 reads or writes are HS256 under
 * the secret itself, because that is all `encodeToken` and `validateToken`
 * accept.
 *
 * Passwords pass through here on their way to Auth0 and nowhere else: they
 * are never logged, stored, or put in an error message.
 */
@Injectable()
export class AccountLinkService {
  private readonly logger = new Logger(AccountLinkService.name)

  constructor(
    private readonly configService: TypedConfigService,
    private readonly auth0Management: Auth0ManagementService,
    private readonly linkedIdentity: LinkedIdentityService,
  ) {}

  /** Verify the session token the Action sent the browser here with. */
  async readSession(sessionToken: string): Promise<AccountLinkSession> {
    const { payload } = await jwtVerify(sessionToken, this.signingKey(), { algorithms: ['HS256'] })
    return readAccountLinkSession(payload)
  }

  /**
   * Prove the password for the state's address, then link.
   *
   * An address with a password account is checked with the password-realm
   * grant; one without gets an account with this password. `clientIp` is the
   * browser's, which Auth0's brute-force protection counts attempts against.
   */
  async submitPassword(state: LinkPageState, password: string, clientIp: string): Promise<PasswordAttempt> {
    if (password === '') {
      return { kind: 'refused', message: 'Enter the password.', retry: true }
    }

    let primaryUserId: string
    try {
      primaryUserId = state.signUp
        ? await this.signUp(state, password)
        : await this.checkPassword(state, password, clientIp)
    } catch (error) {
      if (error instanceof PasswordRefusedError) {
        return { kind: 'refused', message: error.message, retry: error.retry }
      }
      if (error instanceof AccountMismatchError) {
        this.logger.warn(`Account link rejected for ${state.socialUserId}: ${error.message}`)
        return { kind: 'finished', outcome: { outcome: 'mismatch' } }
      }
      this.logger.error(`Account link password step failed for ${state.socialUserId}: ${errorMessage(error)}`)
      return { kind: 'finished', outcome: { outcome: 'failed' } }
    }

    try {
      // Local data first, the tenant link last. The link is the step that
      // cannot be retried: once Auth0 folds the identity in, later social
      // logins reach the password account directly and never pass through here
      // again, so anything not yet moved would stay stranded. Moving first
      // leaves a failed link retryable, since the next social login runs this
      // flow again and moving is idempotent.
      await this.linkedIdentity.adopt(primaryUserId, state.socialUserId)
      await this.auth0Management.linkIdentity(primaryUserId, state.socialUserId)
    } catch (error) {
      this.logger.error(`Account link failed for ${state.socialUserId} -> ${primaryUserId}: ${errorMessage(error)}`)
      return { kind: 'finished', outcome: { outcome: 'failed' } }
    }
    return { kind: 'finished', outcome: { outcome: 'linked', primaryUserId } }
  }

  /** Ask Auth0 to email a password reset link to the state's address. */
  async requestPasswordReset(state: LinkPageState): Promise<void> {
    await axios.post(
      this.configService.getOrThrow('oidc.accountLink.changePasswordUrl'),
      {
        client_id: this.configService.getOrThrow('oidc.accountLink.passwordClientId'),
        email: state.email,
        connection: state.connection,
      },
      { maxRedirects: 0 },
    )
  }

  /**
   * The `/continue` URL that resumes the Auth0 transaction with an outcome.
   *
   * The claims are the ones Auth0 lists for this token: `state`, which
   * `validateToken` compares with the transaction's own, `sub` for the user
   * that transaction is about, `iss` for the application the redirect
   * targets, and a short `exp`.
   * https://auth0.com/docs/customize/actions/explore-triggers/signup-and-login-triggers/login-trigger/redirect-with-actions
   */
  async continueUrl(
    state: { transactionState: string; socialUserId: string },
    result: AccountLinkOutcome,
  ): Promise<string> {
    const url = new URL(this.configService.getOrThrow('oidc.accountLink.continueUrl'))
    const token = await new SignJWT({
      state: state.transactionState,
      outcome: result.outcome,
      ...(result.outcome === 'linked' && { primary_user_id: result.primaryUserId }),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(state.socialUserId)
      .setIssuer(url.origin)
      .setIssuedAt()
      .setExpirationTime(`${CONTINUE_TOKEN_TTL_SECONDS}s`)
      .sign(this.signingKey())

    url.search = new URLSearchParams({ state: state.transactionState, link_token: token }).toString()
    return url.toString()
  }

  /**
   * The password account the password opens, verified to hold the address.
   *
   * An address its own account never verified is marked verified here: the
   * social provider, or the email Form before it, has just proved it, and the
   * password proves the account.
   */
  private async checkPassword(state: LinkPageState, password: string, clientIp: string): Promise<string> {
    const response = await axios.post(
      this.configService.getOrThrow('oidc.accountLink.tokenUrl'),
      new URLSearchParams({
        grant_type: PASSWORD_REALM_GRANT,
        realm: state.connection,
        username: state.email,
        password,
        client_id: this.configService.getOrThrow('oidc.accountLink.passwordClientId'),
        client_secret: this.configService.getOrThrow('oidc.accountLink.passwordClientSecret'),
        scope: 'openid email',
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Honoured only because the client trusts this header; without it
          // every attempt would count against this API's own address.
          'auth0-forwarded-for': clientIp,
        },
        maxRedirects: 0,
        validateStatus: () => true,
      },
    )
    if (response.status !== 200) {
      throw refusalFromTokenEndpoint(response.status, response.data)
    }
    const idToken = response.data?.id_token
    if (typeof idToken !== 'string' || idToken === '') {
      throw new Error('token endpoint returned no ID token')
    }
    const primary = readAuthenticatedPrimary(
      idToken,
      {
        issuer: this.configService.getOrThrow('oidc.accountLink.issuer'),
        clientId: this.configService.getOrThrow('oidc.accountLink.passwordClientId'),
      },
      state.email,
    )
    if (!primary.emailVerified) await this.auth0Management.markEmailVerified(primary.userId)
    return primary.userId
  }

  /**
   * A new password account for the address, whose address is verified for
   * the same reason `checkPassword` gives.
   */
  private async signUp(state: LinkPageState, password: string): Promise<string> {
    const response = await axios.post(
      this.configService.getOrThrow('oidc.accountLink.signupUrl'),
      {
        client_id: this.configService.getOrThrow('oidc.accountLink.passwordClientId'),
        email: state.email,
        password,
        connection: state.connection,
      },
      { maxRedirects: 0, validateStatus: () => true },
    )
    if (response.status !== 200) {
      throw refusalFromSignup(response.status, response.data)
    }
    const id = response.data?._id
    if (typeof id !== 'string' || id === '') {
      throw new Error('sign-up returned no user id')
    }
    const userId = `auth0|${id}`
    await this.auth0Management.markEmailVerified(userId)
    return userId
  }

  private signingKey(): Uint8Array {
    return new TextEncoder().encode(this.configService.getOrThrow('oidc.accountLink.redirectSecret'))
  }
}

/** The account the password opened is not the one the link needs. */
export class AccountMismatchError extends Error {}

/** Auth0 turned the password down, with a reason the page can show. */
class PasswordRefusedError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message)
  }
}

/**
 * The token endpoint's answer to a password it did not accept.
 *
 * A wrong password can be tried again. MFA, a blocked account, a leaked
 * password and the like cannot be fixed on this page, so it offers only
 * Cancel. Anything without a reason is a failure, not a refusal.
 */
function refusalFromTokenEndpoint(status: number, body: unknown): Error {
  const { error, error_description: description } = (body ?? {}) as Record<string, unknown>
  if (error === 'mfa_required') {
    return new PasswordRefusedError(MFA_REFUSAL, false)
  }
  if (status >= 400 && status < 500 && typeof description === 'string' && description !== '') {
    return new PasswordRefusedError(description, error === 'invalid_grant')
  }
  return new Error(`token endpoint answered ${status}${typeof error === 'string' ? ` ${error}` : ''}`)
}

/**
 * The sign-up endpoint's answer to a password it did not accept. A password
 * policy miss can be fixed by trying another; anything else cannot.
 */
function refusalFromSignup(status: number, body: unknown): Error {
  const { name, code, message, description, policy } = (body ?? {}) as Record<string, unknown>
  if (status >= 400 && status < 500) {
    const reason = [message, typeof description === 'string' ? description : undefined, policy]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join('\n')
    if (reason !== '') {
      return new PasswordRefusedError(reason, name === 'PasswordStrengthError' || code === 'invalid_password')
    }
  }
  return new Error(`sign-up answered ${status}`)
}

/**
 * Who the password opened, when that is the account to link into, and
 * whether the token already vouches for its address.
 *
 * Read, not verified: the token arrived directly from the token endpoint over
 * TLS, which OIDC Core 3.1.3.7 step 6 accepts in place of checking the
 * signature. The issuer, audience and expiry checks it still requires are here.
 */
export function readAuthenticatedPrimary(
  idToken: string,
  expected: { issuer: string; clientId: string },
  email: string,
): { userId: string; emailVerified: boolean } {
  const claims = decodeJwt(idToken)
  if (claims.iss !== expected.issuer) {
    throw new AccountMismatchError('ID token was issued by another tenant')
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(expected.clientId)) {
    throw new AccountMismatchError('ID token was issued to another client')
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new AccountMismatchError('ID token has expired')
  }
  if (typeof claims.sub !== 'string' || !claims.sub.startsWith('auth0|')) {
    throw new AccountMismatchError('the account is not a database account')
  }
  if (typeof claims.email !== 'string' || claims.email.toLowerCase() !== email.toLowerCase()) {
    throw new AccountMismatchError('database account holds a different address')
  }
  return { userId: claims.sub, emailVerified: claims.email_verified === true }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
