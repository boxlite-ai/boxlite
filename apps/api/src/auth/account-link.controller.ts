/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Controller, Get, Logger, NotFoundException, Query, Res, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Response } from 'express'
import { AnonymousRateLimitGuard } from '../common/guards/anonymous-rate-limit.guard'
import { TypedConfigService } from '../config/typed-config.service'
import { AccountLinkService, AccountLinkSession, AccountLinkState } from './account-link.service'

/**
 * The second `/authorize` the user is sent through.
 *
 * `prompt=login` is what makes this an authentication rather than a silent
 * replay: without it the tenant would answer from the session cookie the social
 * login just set, and the link would be granted to whoever holds that cookie
 * instead of to whoever knows the password.
 *
 * `connection` pins the attempt to the database connection, so the social
 * buttons never render on that page and cannot satisfy it. When the address
 * has no password account yet, `screen_hint=signup` opens the tenant's own
 * sign-up instead, which verifies the address before it lets a password be set.
 */
export function buildSecondAuthorizeUrl(options: {
  authorizeUrl: string
  clientId: string
  session: AccountLinkSession
  state: string
  codeChallenge: string
  signUp: boolean
}): string {
  const url = new URL(options.authorizeUrl)
  url.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    redirect_uri: options.session.callbackUrl,
    scope: 'openid email',
    connection: options.session.connection,
    prompt: 'login',
    login_hint: options.session.email,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    ...(options.signUp && { screen_hint: 'signup' }),
  }).toString()
  return url.toString()
}

/**
 * Excluded from the OpenAPI document on purpose: these are browser redirects
 * Auth0 drives mid-login, never calls an SDK client makes.
 */
@ApiExcludeController()
@Controller('auth/link')
export class AccountLinkController {
  private readonly logger = new Logger(AccountLinkController.name)

  constructor(
    private readonly configService: TypedConfigService,
    private readonly accountLink: AccountLinkService,
  ) {}

  /**
   * Where the Post-Login Action sends the browser.
   *
   * Auth0 appends `state` itself and expects the same value back when the
   * transaction resumes, so it travels through the second sign-in inside the
   * state this service encrypts.
   */
  @Get('start')
  @UseGuards(AnonymousRateLimitGuard)
  async start(
    @Query('session_token') sessionToken: string | undefined,
    @Query('state') transactionState: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    this.requireEnabled()
    if (!transactionState) {
      throw new BadRequestException('Missing state')
    }

    let session: AccountLinkSession
    try {
      session = await this.accountLink.readSession(sessionToken ?? '')
    } catch (error) {
      // The token is the tenant's, not the user's, so there is nothing here for
      // them to correct; the reason goes to the log, not the response.
      this.logger.warn(`Rejected account link session token: ${errorMessage(error)}`)
      throw new BadRequestException('Invalid account link session')
    }

    const { state, codeChallenge } = await this.accountLink.beginSignIn(session, transactionState)
    res.redirect(
      302,
      buildSecondAuthorizeUrl({
        authorizeUrl: this.configService.getOrThrow('oidc.accountLink.authorizeUrl'),
        clientId: this.configService.getOrThrow('oidc.accountLink.clientId'),
        session,
        state,
        codeChallenge,
        signUp: !(await this.accountLink.hasDatabaseAccount(session)),
      }),
    )
  }

  /**
   * Where the tenant sends the browser once the second sign-in ends.
   *
   * Whatever happened there, the browser goes back to the Auth0 transaction,
   * because only the Action can finish or refuse it. The single exception is a
   * state this service did not mint: then there is no transaction to return to.
   */
  @Get('callback')
  @UseGuards(AnonymousRateLimitGuard)
  async callback(
    @Query('state') stateToken: string | undefined,
    @Query('code') code: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    this.requireEnabled()

    let state: AccountLinkState
    try {
      state = await this.accountLink.readState(stateToken ?? '')
    } catch (reason) {
      this.logger.warn(`Rejected account link callback state: ${errorMessage(reason)}`)
      throw new BadRequestException('Invalid account link state')
    }

    const result =
      error || !code
        ? // The tenant reports a cancelled or refused sign-in as `error`; the
          // user already saw why on its page.
          ({ outcome: 'cancelled' } as const)
        : await this.accountLink.complete(state, code)

    res.redirect(302, await this.accountLink.continueUrl(state, result))
  }

  private requireEnabled(): void {
    if (!this.configService.get('oidc.accountLink.enabled')) {
      throw new NotFoundException()
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
