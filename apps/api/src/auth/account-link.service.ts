/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { EncryptJWT, JWTPayload, SignJWT, decodeJwt, jwtDecrypt, jwtVerify } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'
import { Auth0ManagementService } from '../user/auth0-management.service'
import { LinkedIdentityService } from '../user/linked-identity.service'

/** The one path the callback is served at; see AccountLinkController. */
export const ACCOUNT_LINK_CALLBACK_PATH = '/api/auth/link/callback'

/**
 * What the Post-Login Action hands over when it interrupts a social login
 * (POL-555): who is signing in, the address they now have to prove they own,
 * and — from the values the tenant configurator deployed — which database
 * connection that proof happens on and where the tenant returns afterwards.
 */
export interface AccountLinkSession {
  socialUserId: string
  email: string
  connection: string
  callbackUrl: string
}

/** The same session carried through the second sign-in, with its PKCE key. */
export interface AccountLinkState extends AccountLinkSession {
  transactionState: string
  codeVerifier: string
}

/**
 * How the second sign-in ended, as the Action reads it on `/continue`.
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
 * How long the state minted at the start stays acceptable at the callback.
 *
 * It bounds one password entry, or one sign-up, on the tenant's own page. The
 * login transaction Auth0 holds open expires on a similar order, so a longer
 * window here would only keep a dead transaction alive.
 */
const LINK_STATE_TTL_SECONDS = 600

/**
 * How long the token carried back to `/continue` stays acceptable. The browser
 * follows that redirect immediately, so this only has to outlast one hop.
 */
const CONTINUE_TOKEN_TTL_SECONDS = 60

/**
 * Read the claims the Action signed.
 *
 * Read strictly: this payload decides which address the user is about to be
 * asked to authenticate against and where the tenant sends them afterwards, so
 * a missing or oddly-typed claim has to stop the flow rather than send them
 * somewhere half-specified.
 */
export function readAccountLinkSession(payload: JWTPayload): AccountLinkSession {
  const { sub: socialUserId, email, connection, callback } = payload
  if (typeof socialUserId !== 'string' || socialUserId.trim() === '') {
    throw new Error('session token carries no subject')
  }
  if (typeof email !== 'string' || email.trim() === '') {
    throw new Error('session token carries no email')
  }
  if (typeof connection !== 'string' || connection.trim() === '') {
    throw new Error('session token carries no database connection')
  }
  if (typeof callback !== 'string' || new URL(callback).pathname !== ACCOUNT_LINK_CALLBACK_PATH) {
    throw new Error('session token carries no account link callback')
  }
  return { socialUserId, email: email.trim(), connection, callbackUrl: callback }
}

/**
 * The login-time account link, end to end on the API side.
 *
 * The controller only moves requests and redirects; every token this flow
 * mints or accepts, and every call it makes to the tenant, is here.
 *
 * One secret keys all of it. The two tokens Auth0 reads or writes are HS256
 * under the secret itself, because that is all `encodeToken` and
 * `validateToken` accept. The state only this service reads is encrypted
 * instead — it carries the PKCE verifier through the browser — under a key
 * derived from the secret, so signing and encryption never share key bytes.
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
   * Start a second sign-in that only this service can finish.
   *
   * The returned challenge goes to the tenant; the verifier stays inside the
   * encrypted state, which the browser carries but cannot open.
   */
  async beginSignIn(
    session: AccountLinkSession,
    transactionState: string,
  ): Promise<{ state: string; codeChallenge: string }> {
    const codeVerifier = randomBytes(32).toString('base64url')
    const state = await new EncryptJWT({
      tx: transactionState,
      email: session.email,
      connection: session.connection,
      callback: session.callbackUrl,
      cv: codeVerifier,
    })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setSubject(session.socialUserId)
      .setIssuedAt()
      .setExpirationTime(`${LINK_STATE_TTL_SECONDS}s`)
      .encrypt(this.stateKey())
    return { state, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url') }
  }

  /** Accept only a state this service encrypted. */
  async readState(state: string): Promise<AccountLinkState> {
    const { payload } = await jwtDecrypt(state, this.stateKey())
    if (typeof payload.tx !== 'string' || payload.tx === '') {
      throw new Error('state carries no Auth0 transaction')
    }
    if (typeof payload.cv !== 'string' || payload.cv === '') {
      throw new Error('state carries no PKCE verifier')
    }
    return { ...readAccountLinkSession(payload), transactionState: payload.tx, codeVerifier: payload.cv }
  }

  /**
   * Whether the address already has a password account to sign in to, or the
   * second sign-in has to create one.
   */
  async hasDatabaseAccount(session: AccountLinkSession): Promise<boolean> {
    const users = await this.auth0Management.usersByEmail(session.email)
    return users.some((user) => user.identities?.some((identity) => identity.connection === session.connection))
  }

  /**
   * Finish the link once the tenant has sent the browser back with a code.
   *
   * The code's ID token is who just proved the password. It must be a database
   * account holding the address the social login claimed; anyone else — a
   * different account typed in on that page, say — is a mismatch, not a link.
   */
  async complete(state: AccountLinkState, code: string): Promise<AccountLinkOutcome> {
    let primaryUserId: string
    try {
      const primary = readAuthenticatedPrimary(
        await this.exchangeCode(state, code),
        {
          issuer: this.configService.getOrThrow('oidc.accountLink.issuer'),
          clientId: this.configService.getOrThrow('oidc.accountLink.clientId'),
        },
        state.email,
      )
      if (!primary.emailVerified) await this.requireVerifiedAtTenant(primary.userId, state.email)
      primaryUserId = primary.userId
    } catch (error) {
      if (error instanceof AccountMismatchError) {
        this.logger.warn(`Account link rejected for ${state.socialUserId}: ${error.message}`)
        return { outcome: 'mismatch' }
      }
      this.logger.error(`Account link code exchange failed for ${state.socialUserId}: ${errorMessage(error)}`)
      return { outcome: 'failed' }
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
      return { outcome: 'failed' }
    }
    return { outcome: 'linked', primaryUserId }
  }

  /**
   * The `/continue` URL that resumes the Auth0 transaction with an outcome.
   *
   * Auth0's `validateToken` accepts the token only when its `state` claim is
   * the transaction's own; `sub` names the user that transaction is about.
   */
  async continueUrl(state: AccountLinkState, result: AccountLinkOutcome): Promise<string> {
    const token = await new SignJWT({
      state: state.transactionState,
      outcome: result.outcome,
      ...(result.outcome === 'linked' && { primary_user_id: result.primaryUserId }),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(state.socialUserId)
      .setIssuedAt()
      .setExpirationTime(`${CONTINUE_TOKEN_TTL_SECONDS}s`)
      .sign(this.signingKey())

    const url = new URL(this.configService.getOrThrow('oidc.accountLink.continueUrl'))
    url.search = new URLSearchParams({ state: state.transactionState, link_token: token }).toString()
    return url.toString()
  }

  /**
   * An ID token saying "unverified" can be older than the account.
   *
   * A password account that never verified its address is sent through the
   * email Form during the second sign-in; the Form marks it verified, but the
   * ID token can still carry the value from before. The tenant's own record
   * decides, and the address must still match there too.
   */
  private async requireVerifiedAtTenant(userId: string, email: string): Promise<void> {
    const user = await this.auth0Management.getUser(userId)
    if (user.email_verified !== true || user.email?.toLowerCase() !== email.toLowerCase()) {
      throw new AccountMismatchError('database account address is not verified')
    }
  }

  /**
   * The dashboard's client is public, so the code is redeemed with the PKCE
   * verifier in place of a client secret (RFC 7636 §4.5).
   */
  private async exchangeCode(state: AccountLinkState, code: string): Promise<string> {
    const response = await axios.post(
      this.configService.getOrThrow('oidc.accountLink.tokenUrl'),
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.configService.getOrThrow('oidc.accountLink.clientId'),
        code,
        code_verifier: state.codeVerifier,
        redirect_uri: state.callbackUrl,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, maxRedirects: 0 },
    )
    const idToken = response.data?.id_token
    if (typeof idToken !== 'string' || idToken === '') {
      throw new Error('token endpoint returned no ID token')
    }
    return idToken
  }

  private signingKey(): Uint8Array {
    return new TextEncoder().encode(this.configService.getOrThrow('oidc.accountLink.redirectSecret'))
  }

  private stateKey(): Uint8Array {
    return new Uint8Array(
      hkdfSync(
        'sha256',
        this.configService.getOrThrow('oidc.accountLink.redirectSecret'),
        new Uint8Array(),
        'boxlite-account-link-state',
        32,
      ),
    )
  }
}

/** The second sign-in proved someone other than the account the link needs. */
export class AccountMismatchError extends Error {}

/**
 * Who the second sign-in authenticated, when that is the account to link into,
 * and whether the token already vouches for its address.
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
    throw new AccountMismatchError('ID token is not for the dashboard client')
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new AccountMismatchError('ID token has expired')
  }
  if (typeof claims.sub !== 'string' || !claims.sub.startsWith('auth0|')) {
    throw new AccountMismatchError('second sign-in was not a database account')
  }
  if (typeof claims.email !== 'string' || claims.email.toLowerCase() !== email.toLowerCase()) {
    throw new AccountMismatchError('database account holds a different address')
  }
  return { userId: claims.sub, emailVerified: claims.email_verified === true }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
