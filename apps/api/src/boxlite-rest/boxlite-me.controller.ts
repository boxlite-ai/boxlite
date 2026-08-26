/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags, ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { AuthContext as AuthCtx, OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { effectivePermissions } from '../api-key/api-key-grant'
import { resolveApiScopes } from './api-scope'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationService } from '../organization/services/organization.service'
import { OrganizationUserService } from '../organization/services/organization-user.service'
import { PrincipalDto } from './dto/principal.dto'
import { RestApiScope } from './api-scope'

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
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly organizationUserService: OrganizationUserService,
  ) {}

  @Get('me')
  @RestApiScope('me:read')
  async getMe(@AuthContext() ctx: AuthCtx): Promise<PrincipalDto> {
    const pathPrefix = await this.resolvePathPrefix(ctx)
    const scopes = resolveApiScopes(await this.honouredPermissions(ctx, pathPrefix))

    const principalType: 'user' | 'service_account' = ctx.apiKey ? 'service_account' : 'user'

    return {
      sub: ctx.userId,
      principal_type: principalType,
      email: ctx.email || undefined,
      display_name: undefined,
      path_prefix: pathPrefix,
      // Derived from what the resource guard will actually honour for this
      // credential, so a scope is present exactly when the routes behind it
      // are reachable. The previous constant claimed image scopes this
      // deployment serves no route for, and never mentioned volumes at all.
      scopes,
      // Source of truth for key expiry is ApiKey.expiresAt — the same column the
      // dashboard's `/api-keys` list renders. Returning a hardcoded null here let
      // clients believe a soon-to-expire key was permanent (P1-2). `null` stays
      // correct for non-expiring keys and for interactive user sessions (no apiKey).
      expires_at: ctx.apiKey?.expiresAt ? ctx.apiKey.expiresAt.toISOString() : null,
    }
  }

  /**
   * The permissions the resource guard would honour for this caller.
   *
   * Every other route runs behind OrganizationResourceActionGuard, which
   * resolves the caller's membership onto the request before the handler sees
   * it. `/v1/me` is guarded by CombinedAuthGuard alone, so an interactive
   * session arrives carrying a user id and nothing more — resolve the
   * membership here, or an owner who reaches every route is told they hold
   * nothing. API keys carry their own permissions and need no lookup.
   */
  private async honouredPermissions(
    ctx: AuthCtx,
    organizationId: string | null,
  ): Promise<OrganizationResourcePermission[] | null> {
    if (ctx.apiKey || !organizationId) {
      return effectivePermissions(ctx as OrganizationAuthContext)
    }

    const organizationUser = await this.organizationUserService.findOne(organizationId, ctx.userId)
    return effectivePermissions({ ...ctx, organizationId, organizationUser } as OrganizationAuthContext)
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
