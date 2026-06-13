/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { AuthContext as AuthCtx } from '../common/interfaces/auth-context.interface'
import { OrganizationService } from '../organization/services/organization.service'
import { PrincipalDto } from './dto/principal.dto'

/**
 * `GET /v1/me` — identity for the calling credential.
 *
 * Returns a [`PrincipalDto`] regardless of how the Bearer token was issued
 * (API key, OAuth device-flow access_token, or future federated source).
 * The CLI uses this to validate freshly-pasted keys and to render the
 * `Logged in as` banner.
 *
 * Spec: `openapi/box.openapi.yaml` § GET /me.
 */
@ApiExcludeController()
@ApiTags('BoxLite REST')
@Controller('v1')
@UseGuards(CombinedAuthGuard)
@ApiBearerAuth()
export class BoxliteMeController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get('me')
  async getMe(@AuthContext() ctx: AuthCtx): Promise<PrincipalDto> {
    const pathPrefix = await this.resolvePathPrefix(ctx)

    const principalType: 'user' | 'service_account' = ctx.apiKey ? 'service_account' : 'user'

    return {
      sub: ctx.userId,
      principal_type: principalType,
      email: ctx.email || undefined,
      display_name: undefined,
      path_prefix: pathPrefix,
      // TODO: source scopes from ctx.apiKey?.scopes once the ApiKey entity
      // has a `scopes` column. For now grant the full set used by the OpenAPI
      // spec's documented scope vocabulary.
      scopes: ['box:read', 'box:write', 'box:exec', 'box:delete', 'image:read', 'image:write', 'me:read'],
      // Source of truth for key expiry is ApiKey.expiresAt — the same column the
      // dashboard's `/api-keys` list renders. Returning a hardcoded null here let
      // clients believe a soon-to-expire key was permanent (P1-2). `null` stays
      // correct for non-expiring keys and for interactive user sessions (no apiKey).
      expires_at: ctx.apiKey?.expiresAt ? ctx.apiKey.expiresAt.toISOString() : null,
    }
  }

  /**
   * Resolve the routing-slot value for the calling credential.
   *
   * API keys carry their org binding directly. OIDC tokens carry no
   * org claim, so we look it up: prefer the user's default org;
   * otherwise the first membership; otherwise `null` (no scope yet —
   * the field stays present in the response envelope with explicit
   * `null` per the OpenAPI contract).
   */
  private async resolvePathPrefix(ctx: AuthCtx): Promise<string | null> {
    if (ctx.apiKey?.organizationId) {
      return ctx.apiKey.organizationId
    }
    const memberships = await this.organizationService.findByUserWithDefaultFlag(ctx.userId)
    if (memberships.length === 0) {
      return null
    }
    return (memberships.find((membership) => membership.isDefaultForAuthenticatedUser) ?? memberships[0]).organization
      .id
  }
}
