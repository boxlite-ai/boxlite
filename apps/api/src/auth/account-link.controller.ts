/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Request, Response } from 'express'
import { AnonymousRateLimitGuard } from '../common/guards/anonymous-rate-limit.guard'
import { TypedConfigService } from '../config/typed-config.service'
import { AccountLinkOutcome, AccountLinkService, AccountLinkSession, LinkPageState } from './account-link.service'

// The social providers the Action can hand over, by the prefix of their user id.
const PROVIDER_NAMES: Record<string, string> = { 'google-oauth2': 'Google', github: 'GitHub' }

/** What the password page shows besides the session it is for. */
export interface LinkPage {
  state: LinkPageState
  /** The encrypted state the form posts back. */
  token: string
  error?: string
  notice?: string
  /** False once Auth0 has refused in a way another password cannot fix. */
  retry?: boolean
}

/**
 * The page the account link asks for the password on.
 *
 * It is BoxLite's own rather than Auth0's because Auth0's password page lets
 * the address be edited and says nothing about linking, and this tenant's plan
 * cannot change that. The address is shown, never taken from the form: the
 * encrypted state decides whose password this is.
 */
export function renderLinkPage(page: LinkPage): string {
  const { state } = page
  const retry = page.retry ?? true
  const provider = escapeHtml(PROVIDER_NAMES[state.socialUserId.split('|')[0]] ?? 'social')
  const email = escapeHtml(state.email)
  const lead = state.signUp
    ? `BoxLite accounts sign in with a password. Choose one for <strong>${email}</strong>, and your ${provider} sign-in will be linked to the new account.`
    : `<strong>${email}</strong> already has a BoxLite account. Enter its password to link your ${provider} sign-in to it.`
  const passwordFields = retry
    ? `<label for="password">${state.signUp ? 'New password' : 'Password'}</label>
<input id="password" name="password" type="password" autocomplete="${state.signUp ? 'new-password' : 'current-password'}" required autofocus>
<button id="link" type="submit" name="intent" value="link">${state.signUp ? 'Create password and link' : 'Link accounts'}</button>`
    : ''
  const reset =
    retry && !state.signUp
      ? `<button id="reset" class="text" type="submit" name="intent" value="reset" formnovalidate>Forgot password?</button>`
      : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link your ${provider} sign-in</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14161a;color:#e6e6e6;font:15px/1.5 system-ui,sans-serif}
main{box-sizing:border-box;width:min(400px,100% - 32px);padding:40px;background:#1c1f24;border:1px solid #2c3036}
h1{margin:0 0 16px;font-size:20px;font-weight:500}
p{margin:0 0 12px}
form{display:grid;gap:8px;margin-top:20px}
label{font-size:13px;color:#a8adb5}
input{box-sizing:border-box;width:100%;padding:11px 12px;background:#14161a;border:1px solid #2c3036;color:inherit;font:inherit}
input[readonly]{color:#a8adb5}
input:focus{outline:none;border-color:#3b9eff}
button{padding:12px;border:1px solid #2c3036;background:none;color:inherit;font:inherit;cursor:pointer}
button#link{margin-top:12px;background:#fff;border-color:#fff;color:#14161a}
button.text{border:0;padding:4px 0;color:#3b9eff;text-align:left}
.error,.notice{padding:10px 12px;border:1px solid;white-space:pre-line}
.error{border-color:#8a3a3a;background:#2a1a1a}
.notice{border-color:#2c5a3a;background:#18261c}
</style>
</head>
<body>
<main>
<h1>Link your ${provider} sign-in</h1>
<p>${lead}</p>
<p>After that, ${provider} and the password both open the same BoxLite account. The address cannot be changed here: it is the one your ${provider} sign-in uses.</p>
${page.error ? `<p class="error" role="alert">${escapeHtml(page.error)}</p>` : ''}
${page.notice ? `<p class="notice" role="status">${escapeHtml(page.notice)}</p>` : ''}
<form method="post" action="password">
<input type="hidden" name="state" value="${escapeHtml(page.token)}">
<label for="email">Email</label>
<input id="email" name="username" type="email" value="${email}" autocomplete="username" readonly>
${passwordFields}
<button id="cancel" type="submit" name="intent" value="cancel" formnovalidate>Cancel</button>
${reset}
</form>
</main>
</body>
</html>
`
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return value.replace(/[&<>"']/g, (char) => entities[char])
}

/**
 * Excluded from the OpenAPI document on purpose: these are the pages and
 * redirects Auth0 drives mid-login, never calls an SDK client makes.
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
   * transaction resumes, so it travels through the password page inside the
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

    const { state, token } = await this.accountLink.beginLink(session, transactionState)
    this.sendPage(res, { state, token })
  }

  /**
   * What the password page posts: link with this password, email a reset
   * link, or give up.
   *
   * Every ending goes back to the Auth0 transaction, because only the Action
   * can finish or refuse it. The single exception is a state this service did
   * not mint: then there is no transaction to return to.
   */
  @Post('password')
  @UseGuards(AnonymousRateLimitGuard)
  async password(
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.requireEnabled()

    const token = typeof body?.state === 'string' ? body.state : ''
    let state: LinkPageState
    try {
      state = await this.accountLink.readPageState(token)
    } catch (reason) {
      this.logger.warn(`Rejected account link password state: ${errorMessage(reason)}`)
      throw new BadRequestException('Invalid account link state')
    }

    if (body?.intent === 'cancel') {
      return this.resume(res, state, { outcome: 'cancelled' })
    }

    if (body?.intent === 'reset') {
      try {
        await this.accountLink.requestPasswordReset(state)
      } catch (error) {
        this.logger.error(`Account link password reset failed for ${state.socialUserId}: ${errorMessage(error)}`)
        return this.sendPage(res, { state, token, error: 'The reset email could not be sent. Try again, or cancel.' })
      }
      return this.sendPage(res, {
        state,
        token,
        notice: `A password reset link is on its way to ${state.email}. Set a new password there, then enter it here.`,
      })
    }

    const password = typeof body?.password === 'string' ? body.password : ''
    const attempt = await this.accountLink.submitPassword(state, password, clientIp(req))
    if (attempt.kind === 'finished') {
      return this.resume(res, state, attempt.outcome)
    }
    this.sendPage(res, { state, token, error: attempt.message, retry: attempt.retry })
  }

  /** 303, so the browser follows the POST with a GET to `/continue`. */
  private async resume(res: Response, state: LinkPageState, outcome: AccountLinkOutcome): Promise<void> {
    res.redirect(303, await this.accountLink.continueUrl(state, outcome))
  }

  private sendPage(res: Response, page: LinkPage): void {
    // The form may only post here, and the redirect that follows it may only
    // reach the tenant's /continue: browsers apply form-action to that
    // redirect as well.
    const tenant = new URL(this.configService.getOrThrow('oidc.accountLink.continueUrl')).origin
    res
      .status(200)
      .set({
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${tenant}; base-uri 'none'; frame-ancestors 'none'`,
        // The URL /start was served at carries the session token.
        'Referrer-Policy': 'no-referrer',
      })
      .type('html')
      .send(renderLinkPage(page))
  }

  private requireEnabled(): void {
    if (!this.configService.get('oidc.accountLink.enabled')) {
      throw new NotFoundException()
    }
  }
}

/** The browser's address, read the way this API's rate limits read it. */
function clientIp(req: Request): string {
  return (req.ips.length ? req.ips[0] : req.ip) ?? ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
