/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import {
  AuthContext as AuthCtx,
  isOrganizationAuthContext,
} from '../common/interfaces/auth-context.interface'
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
@ApiTags('BoxLite REST')
@Controller('v1')
@UseGuards(CombinedAuthGuard)
@ApiBearerAuth()
export class BoxliteMeController {
  @Get('me')
  getMe(@AuthContext() ctx: AuthCtx): PrincipalDto {
    const orgPrefix = isOrganizationAuthContext(ctx) ? ctx.organizationId : 'default'

    const principalType: 'user' | 'service_account' = ctx.apiKey ? 'service_account' : 'user'

    return {
      sub: ctx.userId,
      principal_type: principalType,
      email: ctx.email || undefined,
      display_name: undefined,
      prefix: orgPrefix,
      // TODO: source scopes from ctx.apiKey?.scopes once the ApiKey entity
      // has a `scopes` column. For now grant the full set used by the OpenAPI
      // spec's documented scope vocabulary.
      scopes: [
        'box:read',
        'box:write',
        'box:exec',
        'box:delete',
        'image:read',
        'image:write',
        'snapshot:read',
        'snapshot:write',
        'snapshot:delete',
        'me:read',
      ],
      expires_at: null,
    }
  }
}
