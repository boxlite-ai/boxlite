/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Logger, Query, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Response } from 'express'
import { AnonymousRateLimitGuard } from '../common/guards/anonymous-rate-limit.guard'
import { parseHttpUrl } from '../config/oidc-metadata.service'
import { TypedConfigService } from '../config/typed-config.service'

@ApiTags('auth')
@Controller('auth')
export class LogoutController {
  private readonly logger = new Logger(LogoutController.name)

  constructor(private readonly configService: TypedConfigService) {}

  @Get('end-session')
  @UseGuards(AnonymousRateLimitGuard)
  @ApiOperation({
    summary: 'OIDC RP-initiated logout endpoint',
    description:
      'Implements OpenID Connect RP-Initiated Logout 1.0 for IdPs (e.g. Dex) that do not natively advertise end_session_endpoint. Validates the post-logout redirect target, then 302-redirects the browser back to the SPA.',
  })
  @ApiQuery({ name: 'post_logout_redirect_uri', required: false })
  @ApiQuery({ name: 'id_token_hint', required: false })
  @ApiQuery({ name: 'state', required: false })
  @ApiResponse({ status: 302, description: 'Redirect to post_logout_redirect_uri' })
  @ApiResponse({ status: 400, description: 'post_logout_redirect_uri not allowed' })
  endSession(
    @Query('post_logout_redirect_uri') postLogoutRedirectUri: string | undefined,
    @Query('id_token_hint') _idTokenHint: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    const dashboardUrl = this.configService.getOrThrow('dashboardUrl')
    const allowlist = this.getAllowlist(dashboardUrl)

    const target = postLogoutRedirectUri || dashboardUrl
    if (!validatePostLogoutRedirect(target, allowlist)) {
      this.logger.warn(`Rejected post_logout_redirect_uri: ${target}`)
      res.status(400).send('post_logout_redirect_uri not in allowlist')
      return
    }

    const finalUrl = state ? appendStateParam(target, state) : target
    res.redirect(302, finalUrl)
  }

  private getAllowlist(dashboardUrl: string): string[] {
    const extra = this.configService.get('oidc.postLogoutRedirectAllowlist')
    const extras = extra ? extra.split(',').map((s) => s.trim()).filter(Boolean) : []
    return [dashboardUrl, ...extras].filter(Boolean)
  }
}

/**
 * Open-redirect prevention for RP-initiated logout. Returns true iff `uri`
 * passes the shared `parseHttpUrl` policy AND its origin matches the origin
 * of some allowlist entry. Origin-match (not exact-equality) lets the SPA
 * redirect to deep paths under the same origin without registering each one.
 */
function validatePostLogoutRedirect(uri: string, allowlist: string[]): boolean {
  const target = parseHttpUrl(uri)
  if (!target) return false
  for (const allowed of allowlist) {
    const parsed = parseHttpUrl(allowed)
    if (parsed && parsed.origin === target.origin) return true
  }
  return false
}

function appendStateParam(url: string, state: string): string {
  const u = new URL(url)
  u.searchParams.set('state', state)
  return u.toString()
}
