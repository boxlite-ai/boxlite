/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { JWTPayload, SignJWT, jwtVerify } from 'jose'
import { TypedConfigService } from '../config/typed-config.service'

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
 * How long the token carried back to `/continue` stays acceptable. The browser
 * follows that redirect immediately, so this only has to outlast one hop.
 */
const CONTINUE_TOKEN_TTL_SECONDS = 60

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
 * accepts.
 *
 * One secret keys the tokens. The two Auth0 reads or writes are HS256 under
 * the secret itself, because that is all `encodeToken` and `validateToken`
 * accept.
 */
@Injectable()
export class AccountLinkService {
  constructor(private readonly configService: TypedConfigService) {}

  /** Verify the session token the Action sent the browser here with. */
  async readSession(sessionToken: string): Promise<AccountLinkSession> {
    const { payload } = await jwtVerify(sessionToken, this.signingKey(), { algorithms: ['HS256'] })
    return readAccountLinkSession(payload)
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

  private signingKey(): Uint8Array {
    return new TextEncoder().encode(this.configService.getOrThrow('oidc.accountLink.redirectSecret'))
  }
}
