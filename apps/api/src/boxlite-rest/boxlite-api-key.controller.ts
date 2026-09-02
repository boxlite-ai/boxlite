/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { ApiKey } from '../api-key/api-key.entity'
import { expiryBoundOf, ungrantablePermissions } from '../api-key/api-key-grant'
import { ApiKeyService } from '../api-key/api-key.service'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { Audit, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { RestCreateApiKeyDto } from './dto/create-api-key.dto'
import { RestApiScope } from './api-scope'

type RestApiKeySummary = {
  name: string
  permissions: OrganizationResourcePermission[]
  created_at: string
  last_used_at?: string
  expires_at: string | null
}

// `value` is returned by create and never again — the server keeps a hash.
type RestCreatedApiKey = RestApiKeySummary & { value: string }

/**
 * `POST|GET /v1/api-keys`, `DELETE /v1/api-keys/{name}` — issue and retire
 * credentials from code.
 *
 * The dashboard's `/api-keys` controller sits above the versioned namespace
 * and outside `openapi/box.openapi.yaml`, so a customer working from the
 * documented REST surface had no way to mint a key at all — every credential
 * had to come from a browser. That blocks any provisioning flow that runs
 * unattended.
 *
 * Spec-first surface: the contract is `openapi/box.openapi.yaml`, not the
 * generated product spec (which `:prefix` routes would render invalid).
 */
@ApiExcludeController()
@Controller(['v1/api-keys', 'v1/:prefix/api-keys'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
export class BoxliteApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  @HttpCode(201)
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.API_KEY,
    targetIdFromResult: (result: RestCreatedApiKey) => result?.name,
    requestMetadata: {
      body: (req: TypedRequest<RestCreateApiKeyDto>) => ({
        name: req.body?.name,
        permissions: req.body?.permissions,
        expiresAt: req.body?.expires_at,
      }),
    },
  })
  @RestApiScope('api_key:write')
  async create(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() dto: RestCreateApiKeyDto,
  ): Promise<RestCreatedApiKey> {
    const refused = ungrantablePermissions(authContext, dto.permissions)
    if (refused.length > 0) {
      throw new ForbiddenException(`Insufficient permissions for assigning: ${refused.join(', ')}`)
    }

    // A key bounds what it passes on in time as well as in permissions.
    const expiryBound = expiryBoundOf(authContext)
    if (expiryBound && dto.expires_at && dto.expires_at > expiryBound) {
      throw new ForbiddenException(
        `Requested expiry exceeds the calling key's own expiry (${expiryBound.toISOString()})`,
      )
    }

    const { apiKey, value } = await this.apiKeyService.createApiKey(
      authContext.organizationId,
      authContext.userId,
      dto.name,
      dto.permissions,
      dto.expires_at ?? expiryBound,
    )

    return { ...this.toSummary(apiKey), value }
  }

  @Get()
  @RestApiScope('api_key:read')
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<{ api_keys: RestApiKeySummary[] }> {
    const apiKeys = await this.apiKeyService.getApiKeys(authContext.organizationId, authContext.userId)
    return { api_keys: apiKeys.map((apiKey) => this.toSummary(apiKey)) }
  }

  @Delete(':name')
  @HttpCode(204)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.API_KEY,
    targetIdFromRequest: (req) => req.params.name,
  })
  @RestApiScope('api_key:delete')
  async remove(@AuthContext() authContext: OrganizationAuthContext, @Param('name') name: string): Promise<void> {
    await this.apiKeyService.deleteApiKey(authContext.organizationId, authContext.userId, name)
  }

  private toSummary(apiKey: ApiKey): RestApiKeySummary {
    return {
      name: apiKey.name,
      permissions: apiKey.permissions,
      created_at: apiKey.createdAt.toISOString(),
      last_used_at: apiKey.lastUsedAt?.toISOString(),
      expires_at: apiKey.expiresAt ? apiKey.expiresAt.toISOString() : null,
    }
  }
}
