/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Audit, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { ImageDetailDto } from '../image/dto/image.dto'
import { ImageCatalogService, ImageReference } from '../image/services/image-catalog.service'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { CreateAliasDto } from './dto/create-alias.dto'

type RestImageInfo = {
  reference: string
  repository: string
  tag: string
  id: string
  cached_at: string
  size_bytes: number
}

type RestImageVersion = {
  digest: string
  size_bytes: number
  source_ref: string
  recorded_at: string
  aliases: string[]
  last_used_at: string | null
  upstream_missing_at: string | null
}

type RestImageAliasEvent = {
  alias: string
  from_digest: string | null
  to_digest: string
  actor: string | null
  recorded_at: string
}

type RestImageDetail = {
  name: string
  aliases: string[]
  curated: boolean
  versions: RestImageVersion[]
  history: RestImageAliasEvent[]
}

type RestImageUsage = { count: number; limit: number; known_bytes: number }

/**
 * The image catalog on the box API, where an SDK's `rt.images()` reads it.
 *
 * The console reads the same catalog through `/api/images`
 * (`image.controller.ts`); this answers in the box API's snake_case shapes
 * (`openapi/box.openapi.yaml`), with a list shaped like a local cache's — one
 * row per reference — so an SDK lists both alike.
 */
@Controller(['v1/images', 'v1/:prefix/images'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
export class BoxliteImageController {
  constructor(private readonly imageCatalogService: ImageCatalogService) {}

  @Get()
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_IMAGES])
  async list(@AuthContext() authContext: OrganizationAuthContext): Promise<{ images: RestImageInfo[] }> {
    const references = await this.imageCatalogService.listReferences(authContext.organization)
    return { images: references.map(toImageInfo) }
  }

  // Declared before `:name`. Nest matches in declaration order and both are a
  // single segment, so the parameterised route would otherwise read "usage"
  // as an image name.
  @Get('usage')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_IMAGES])
  async usage(@AuthContext() authContext: OrganizationAuthContext): Promise<RestImageUsage> {
    const usage = await this.imageCatalogService.usage(authContext.organization)
    return { count: usage.count, limit: usage.limit, known_bytes: usage.knownBytes }
  }

  @Get(':name')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_IMAGES])
  async get(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('name') name: string,
  ): Promise<RestImageDetail> {
    return toImageDetail(await this.imageCatalogService.get(authContext.organization, name))
  }

  @Post(':name/aliases')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_IMAGES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.IMAGE,
    targetIdFromRequest: (req) => req.params.name,
    requestMetadata: {
      body: (req: TypedRequest<CreateAliasDto>) => ({ alias: req.body?.alias, digest: req.body?.digest }),
    },
  })
  async createAlias(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('name') name: string,
    @Body() request: CreateAliasDto,
  ): Promise<RestImageDetail> {
    return toImageDetail(
      await this.imageCatalogService.createAlias(
        authContext.organization,
        name,
        request.alias,
        { digest: request.digest },
        authContext.userId,
      ),
    )
  }

  @Delete(':name/aliases/:alias')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_IMAGES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.IMAGE,
    targetIdFromRequest: (req) => req.params.name,
    requestMetadata: { query: (req) => ({ alias: req.params.alias }) },
  })
  async deleteAlias(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('name') name: string,
    @Param('alias') alias: string,
  ): Promise<void> {
    await this.imageCatalogService.deleteAlias(authContext.organization, name, alias)
  }

  @Delete(':name')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_IMAGES])
  async remove(@AuthContext() authContext: OrganizationAuthContext, @Param('name') name: string): Promise<void> {
    await this.imageCatalogService.delete(authContext.organization, name)
  }
}

function toImageDetail(detail: ImageDetailDto): RestImageDetail {
  return {
    name: detail.name,
    aliases: detail.aliases,
    curated: detail.curated,
    versions: detail.versions.map((version) => ({
      digest: version.digest,
      size_bytes: version.sizeBytes,
      source_ref: version.sourceRef,
      recorded_at: version.createdAt,
      aliases: version.aliases,
      last_used_at: version.lastUsedAt,
      upstream_missing_at: version.upstreamMissingAt,
    })),
    history: detail.history.map((event) => ({
      alias: event.aliasName,
      from_digest: event.fromDigest,
      to_digest: event.toDigest,
      actor: event.actorId,
      recorded_at: event.createdAt,
    })),
  }
}

function toImageInfo(reference: ImageReference): RestImageInfo {
  return {
    reference: reference.reference,
    repository: reference.name,
    tag: reference.tag,
    id: reference.digest,
    cached_at: reference.recordedAt.toISOString(),
    size_bytes: reference.sizeBytes,
  }
}
