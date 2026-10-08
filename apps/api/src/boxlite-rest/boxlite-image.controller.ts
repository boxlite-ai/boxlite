/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { ImageCatalogService, ImageReference } from '../image/services/image-catalog.service'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'

type RestImageInfo = {
  reference: string
  repository: string
  tag: string
  id: string
  cached_at: string
  size_bytes: number
}

type RestImageDetail = {
  name: string
  tags: string[]
  curated: boolean
  versions: Array<{ digest: string; size_bytes: number; source_ref: string; recorded_at: string }>
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
    const detail = await this.imageCatalogService.get(authContext.organization, name)
    return {
      name: detail.name,
      tags: detail.tags,
      curated: detail.curated,
      versions: detail.versions.map((version) => ({
        digest: version.digest,
        size_bytes: version.sizeBytes,
        source_ref: version.sourceRef,
        recorded_at: version.createdAt,
      })),
    }
  }

  @Delete(':name')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_IMAGES])
  async remove(@AuthContext() authContext: OrganizationAuthContext, @Param('name') name: string): Promise<void> {
    await this.imageCatalogService.delete(authContext.organization, name)
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
