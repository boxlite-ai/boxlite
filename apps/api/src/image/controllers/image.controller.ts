/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Delete, Get, HttpCode, Param, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { ImageDetailDto, ImageDto, ImageUsageDto } from '../dto/image.dto'
import { ImageCatalogService } from '../services/image-catalog.service'

/**
 * The image catalog.
 *
 * There is no create: an image enters the catalog by being used. That is why
 * there is no `write:images` scope either — the write happens when a box
 * reaches STARTED, on the credentials that created the box.
 *
 * Every route is organization-scoped inside the service, by filtering on the
 * organization the credentials carry rather than by a guard on the way in: the
 * catalog has no route that takes an image without also taking an
 * organization, so a lookup that ignored it could not be written.
 */
@ApiTags('images')
@Controller('images')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class ImageController {
  constructor(private readonly imageCatalogService: ImageCatalogService) {}

  @Get()
  @ApiOperation({
    summary: 'List images',
    description:
      'The organization’s images together with the operator’s curated set, which every organization shares and none can delete.',
    operationId: 'listImages',
  })
  @ApiResponse({ status: 200, description: 'The images this organization can boot from', type: [ImageDto] })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_IMAGES])
  async listImages(@AuthContext() authContext: OrganizationAuthContext): Promise<ImageDto[]> {
    return this.imageCatalogService.list(authContext.organization)
  }

  // Declared before `:idOrRef`. Nest matches in declaration order and both are
  // a single segment, so the parameterised route would otherwise swallow this
  // one and answer with "image 'usage' not found".
  @Get('usage')
  @ApiOperation({
    summary: 'Get image usage',
    description:
      'How many images this organization holds against its limit, and the total size its pulled versions declared.',
    operationId: 'getImageUsage',
  })
  @ApiResponse({ status: 200, description: 'Catalog usage for this organization', type: ImageUsageDto })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_IMAGES])
  async getImageUsage(@AuthContext() authContext: OrganizationAuthContext): Promise<ImageUsageDto> {
    return this.imageCatalogService.usage(authContext.organization)
  }

  @Get(':idOrRef')
  @ApiOperation({
    summary: 'Get image details',
    operationId: 'getImage',
  })
  @ApiParam({
    name: 'idOrRef',
    description:
      'Catalog ID, or any reference that names the image — URL-encode a reference, since it contains slashes',
    type: 'string',
    example: 'quay.io%2Facme%2Fapp',
  })
  @ApiResponse({ status: 200, description: 'Image details', type: ImageDetailDto })
  @ApiResponse({ status: 404, description: 'No such image in this organization' })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_IMAGES])
  async getImage(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('idOrRef') idOrRef: string,
  ): Promise<ImageDetailDto> {
    return this.imageCatalogService.get(authContext.organization, idOrRef)
  }

  @Delete(':idOrRef')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove an image from the catalog',
    description:
      'Removes the catalog entry, not the bytes: runners keep whatever they cached, and using the same reference again pulls it back as a new entry. That is also how to pick up a tag that has moved upstream, since a recorded tag keeps the digest it first resolved to.',
    operationId: 'deleteImage',
  })
  @ApiParam({
    name: 'idOrRef',
    description: 'Catalog ID, or any reference that names the image — URL-encode a reference',
    type: 'string',
    example: 'quay.io%2Facme%2Fapp',
  })
  @ApiResponse({ status: 204, description: 'The image is no longer in the catalog' })
  @ApiResponse({ status: 400, description: 'Curated images belong to the operator and cannot be removed' })
  @ApiResponse({ status: 404, description: 'No such image in this organization' })
  @ApiResponse({ status: 409, description: 'Boxes that have not been destroyed can still boot from this image' })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_IMAGES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.IMAGE,
    targetIdFromRequest: (req) => req.params.idOrRef,
  })
  async deleteImage(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('idOrRef') idOrRef: string,
  ): Promise<void> {
    return this.imageCatalogService.delete(authContext.organization, idOrRef)
  }
}
