/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Audit, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { ImageDetailDto } from '../image/dto/image.dto'
import { ImageCatalogService, ImageReference } from '../image/services/image-catalog.service'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { MoveTagDto } from './dto/move-tag.dto'

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
  tags: string[]
  last_used_at: string | null
  upstream_missing_at: string | null
}

type RestImageTagEvent = {
  tag: string
  from_digest: string | null
  to_digest: string
  actor: string | null
  moved_at: string
}

type RestImageDetail = {
  name: string
  tags: string[]
  curated: boolean
  versions: RestImageVersion[]
  history: RestImageTagEvent[]
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
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
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

  /**
   * Point a tag at the version with this digest. The box API's versions carry
   * no id, so the digest names the version; the catalog checks it is one of
   * this image's ready versions. A box already created keeps what it booted.
   */
  @Put(':name/tags/:tag')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_IMAGES])
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.IMAGE,
    targetIdFromRequest: (req) => req.params.name,
    requestMetadata: {
      body: (req: TypedRequest<MoveTagDto>) => ({ tag: req.params.tag, digest: req.body?.digest }),
    },
  })
  async moveTag(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('name') name: string,
    @Param('tag') tag: string,
    @Body() request: MoveTagDto,
  ): Promise<RestImageDetail> {
    const detail = await this.imageCatalogService.moveTag(
      authContext.organization,
      name,
      tag,
      { digest: request.digest },
      authContext.userId,
    )
    return toImageDetail(detail)
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
    tags: detail.tags,
    curated: detail.curated,
    versions: detail.versions.map((version) => ({
      digest: version.digest,
      size_bytes: version.sizeBytes,
      source_ref: version.sourceRef,
      recorded_at: version.createdAt,
      tags: version.tags,
      last_used_at: version.lastUsedAt,
      upstream_missing_at: version.upstreamMissingAt,
    })),
    history: detail.history.map((event) => ({
      tag: event.tagName,
      from_digest: event.fromDigest,
      to_digest: event.toDigest,
      actor: event.actorId,
      moved_at: event.createdAt,
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
