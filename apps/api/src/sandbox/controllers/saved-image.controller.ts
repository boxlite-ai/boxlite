/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Next,
  NotFoundException,
  Param,
  ParseBoolPipe,
  Patch,
  Post,
  Query,
  RawBodyRequest,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common'
import { IncomingMessage, ServerResponse } from 'http'
import { NextFunction } from 'express'
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOAuth2,
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { AuthContext } from '../../common/decorators/auth-context.decorator'
import { CustomHeaders } from '../../common/constants/header.constants'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/auth-context.interface'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Audit, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { UrlDto } from '../../common/dto/url.dto'
import { SavedImageDto } from '../dto/saved-image.dto'
import { CreateSavedImageDto } from '../dto/create-saved-image.dto'
import { PaginatedSavedImagesDto } from '../dto/paginated-saved-images.dto'
import { ListSavedImagesQueryDto } from '../dto/list-saved-images-query.dto'
import { SetSavedImageGeneralStatusDto } from '../dto/update-saved-image.dto'
import { SavedImageAccessGuard } from '../guards/saved-image-access.guard'
import { SavedImageReadAccessGuard } from '../guards/saved-image-read-access.guard'
import { SavedImageState } from '../enums/saved-image-state.enum'
import { LogProxy } from '../proxy/log-proxy'
import { SavedImageService } from '../services/saved-image.service'
import { RunnerService } from '../services/runner.service'

@ApiTags('saved-images')
@ApiExtraModels(SavedImageDto, PaginatedSavedImagesDto)
@Controller('saved-images')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class SavedImageController {
  constructor(
    private readonly savedImageService: SavedImageService,
    private readonly runnerService: RunnerService,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Create a new box saved image',
    operationId: 'createSavedImage',
  })
  @ApiResponse({
    status: 200,
    description: 'The box saved image has been successfully created.',
    type: SavedImageDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_SAVED_IMAGES])
  @Audit({
    action: AuditAction.CREATE,
    targetType: AuditTarget.SAVED_IMAGE,
    targetIdFromResult: (result: SavedImageDto) => result?.id,
    requestMetadata: {
      body: (req: TypedRequest<CreateSavedImageDto>) => ({
        name: req.body?.name,
        imageName: req.body?.imageName,
        entrypoint: req.body?.entrypoint,
        general: req.body?.general,
        cpu: req.body?.cpu,
        memory: req.body?.memory,
        disk: req.body?.disk,
        gpu: req.body?.gpu,
        buildInfo: req.body?.buildInfo,
      }),
    },
  })
  async createSavedImage(
    @AuthContext() authContext: OrganizationAuthContext,
    @Body() createSavedImageDto: CreateSavedImageDto,
  ): Promise<SavedImageDto> {
    if (createSavedImageDto.general && authContext.role !== SystemRole.ADMIN) {
      throw new ForbiddenException('Insufficient permissions for creating general savedImages')
    }

    if (createSavedImageDto.buildInfo) {
      if (createSavedImageDto.imageName) {
        throw new BadRequestError('Cannot specify an image name when using a build info entry')
      }
      if (createSavedImageDto.entrypoint) {
        throw new BadRequestError('Cannot specify an entrypoint when using a build info entry')
      }
    } else if (!createSavedImageDto.imageName) {
      throw new BadRequestError('Must specify an image name when not using a build info entry')
    }

    const savedImage = createSavedImageDto.buildInfo
      ? await this.savedImageService.createFromBuildInfo(authContext.organization, createSavedImageDto)
      : await this.savedImageService.createFromPull(authContext.organization, createSavedImageDto)

    return SavedImageDto.fromSavedImageEntity(savedImage)
  }

  @Get()
  @ApiOperation({
    summary: 'List box savedImages',
    operationId: 'listSavedImages',
  })
  @ApiResponse({
    status: 200,
    description: 'Box savedImages available to the organization',
    schema: {
      oneOf: [
        { type: 'array', items: { $ref: getSchemaPath(SavedImageDto) } },
        { $ref: getSchemaPath(PaginatedSavedImagesDto) },
      ],
    },
  })
  async listSavedImages(
    @AuthContext() authContext: OrganizationAuthContext,
    @Query() queryParams: ListSavedImagesQueryDto,
    @Request() req: { query?: Record<string, unknown> },
  ): Promise<SavedImageDto[] | PaginatedSavedImagesDto> {
    const query = req.query ?? {}
    const hasPagination = ['page', 'limit', 'name', 'sort', 'order'].some((key) =>
      Object.prototype.hasOwnProperty.call(query, key),
    )

    if (!hasPagination) {
      const savedImages = await this.savedImageService.getSystemSavedImages(authContext.organizationId)
      return savedImages.map(SavedImageDto.fromSavedImageEntity)
    }

    const { page, limit, name, sort, order } = queryParams
    const result = await this.savedImageService.getAllSavedImages(
      authContext.organizationId,
      page,
      limit,
      { name },
      { field: sort, direction: order },
    )

    return {
      items: result.items.map(SavedImageDto.fromSavedImageEntity),
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
    }
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get box saved image by ID or name',
    operationId: 'getSavedImage',
  })
  @ApiParam({
    name: 'id',
    description: 'SavedImage ID or name',
  })
  @ApiResponse({
    status: 200,
    description: 'The box saved image',
    type: SavedImageDto,
  })
  @ApiResponse({
    status: 404,
    description: 'SavedImage not found',
  })
  @UseGuards(SavedImageReadAccessGuard)
  async getSavedImage(
    @Param('id') savedImageIdOrName: string,
    @AuthContext() authContext: OrganizationAuthContext,
  ): Promise<SavedImageDto> {
    const savedImage = await this.savedImageService.getSavedImageWithRegions(
      savedImageIdOrName,
      authContext.organizationId,
    )
    return SavedImageDto.fromSavedImageEntity(savedImage)
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete box saved image',
    operationId: 'removeSavedImage',
  })
  @ApiParam({
    name: 'id',
    description: 'SavedImage ID',
  })
  @ApiResponse({
    status: 200,
    description: 'SavedImage has been deleted',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.DELETE_SAVED_IMAGES])
  @UseGuards(SavedImageAccessGuard)
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.SAVED_IMAGE,
    targetIdFromRequest: (req) => req.params.id,
  })
  async removeSavedImage(@Param('id') savedImageId: string): Promise<void> {
    await this.savedImageService.removeSavedImage(savedImageId)
  }

  @Patch(':id/general')
  @ApiOperation({
    summary: 'Set box saved image general status',
    operationId: 'setSavedImageGeneralStatus',
  })
  @ApiParam({
    name: 'id',
    description: 'SavedImage ID',
  })
  @ApiResponse({
    status: 200,
    description: 'SavedImage general status has been set',
    type: SavedImageDto,
  })
  @Audit({
    action: AuditAction.SET_GENERAL_STATUS,
    targetType: AuditTarget.SAVED_IMAGE,
    targetIdFromRequest: (req) => req.params.id,
    requestMetadata: {
      body: (req: TypedRequest<SetSavedImageGeneralStatusDto>) => ({
        general: req.body?.general,
      }),
    },
  })
  async setSavedImageGeneralStatus(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('id') savedImageId: string,
    @Body() dto: SetSavedImageGeneralStatusDto,
  ): Promise<SavedImageDto> {
    if (authContext.role !== SystemRole.ADMIN) {
      throw new ForbiddenException('Insufficient permissions for changing saved image general status')
    }

    const savedImage = await this.savedImageService.setSavedImageGeneralStatus(savedImageId, dto.general)
    return SavedImageDto.fromSavedImageEntity(savedImage)
  }

  @Get(':id/build-logs')
  @ApiOperation({
    summary: 'Get box saved image build logs',
    operationId: 'getSavedImageBuildLogs',
    deprecated: true,
    description: 'This endpoint is deprecated. Use `getSavedImageBuildLogsUrl` instead.',
  })
  @ApiParam({
    name: 'id',
    description: 'SavedImage ID',
  })
  @ApiQuery({
    name: 'follow',
    required: false,
    type: Boolean,
    description: 'Whether to follow the logs stream',
  })
  @UseGuards(SavedImageAccessGuard)
  async getSavedImageBuildLogs(
    @Request() req: RawBodyRequest<IncomingMessage>,
    @Res() res: ServerResponse<IncomingMessage>,
    @Next() next: NextFunction,
    @Param('id') savedImageId: string,
    @Query('follow', new ParseBoolPipe({ optional: true })) follow?: boolean,
  ): Promise<void> {
    let savedImage = await this.savedImageService.getSavedImage(savedImageId)

    if (!savedImage.buildInfo) {
      throw new NotFoundException(`SavedImage ${savedImageId} has no build info`)
    }

    if (savedImage.state == SavedImageState.ACTIVE) {
      res.end()
      return
    }

    const startTime = Date.now()
    const timeoutMs = 30 * 1000

    while (!savedImage.initialRunnerId) {
      if (Date.now() - startTime > timeoutMs) {
        throw new NotFoundException(`Timeout waiting for build runner assignment for savedImage ${savedImageId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      savedImage = await this.savedImageService.getSavedImage(savedImageId)
    }

    const runner = await this.runnerService.findOneOrFail(savedImage.initialRunnerId)

    if (!runner.apiUrl) {
      throw new NotFoundException(`Build runner for savedImage ${savedImageId} has no API URL`)
    }

    const logProxy = new LogProxy(
      runner.apiUrl,
      savedImage.buildInfo.artifactRef,
      runner.apiKey,
      follow === true,
      req,
      res,
      next,
    )
    return logProxy.create()
  }

  @Get(':id/build-logs-url')
  @ApiOperation({
    summary: 'Get box saved image build logs URL',
    operationId: 'getSavedImageBuildLogsUrl',
  })
  @ApiParam({
    name: 'id',
    description: 'SavedImage ID',
  })
  @ApiResponse({
    status: 200,
    description: 'The savedImage build logs URL',
    type: UrlDto,
  })
  @UseGuards(SavedImageAccessGuard)
  async getSavedImageBuildLogsUrl(@Param('id') savedImageId: string): Promise<UrlDto> {
    let savedImage = await this.savedImageService.getSavedImage(savedImageId)

    if (!savedImage.buildInfo) {
      throw new NotFoundException(`SavedImage ${savedImageId} has no build info`)
    }

    const startTime = Date.now()
    const timeoutMs = 30 * 1000

    while (!savedImage.initialRunnerId) {
      if (Date.now() - startTime > timeoutMs) {
        throw new NotFoundException(`Timeout waiting for build runner assignment for savedImage ${savedImageId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
      savedImage = await this.savedImageService.getSavedImage(savedImageId)
    }

    const url = await this.savedImageService.getBuildLogsUrl(savedImage)
    return new UrlDto(url)
  }

  @Post(':id/activate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Activate a box saved image',
    operationId: 'activateSavedImage',
  })
  @ApiParam({
    name: 'id',
    description: 'SavedImage ID',
  })
  @ApiResponse({
    status: 200,
    description: 'The savedImage has been successfully activated.',
    type: SavedImageDto,
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_SAVED_IMAGES])
  @UseGuards(SavedImageAccessGuard)
  @Audit({
    action: AuditAction.ACTIVATE,
    targetType: AuditTarget.SAVED_IMAGE,
    targetIdFromRequest: (req) => req.params.id,
  })
  async activateSavedImage(
    @Param('id') savedImageId: string,
    @AuthContext() authContext: OrganizationAuthContext,
  ): Promise<SavedImageDto> {
    const savedImage = await this.savedImageService.activateSavedImage(savedImageId, authContext.organization)
    return SavedImageDto.fromSavedImageEntity(savedImage)
  }

  @Post(':id/deactivate')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Deactivate a box saved image',
    operationId: 'deactivateSavedImage',
  })
  @ApiParam({
    name: 'id',
    description: 'SavedImage ID',
  })
  @ApiResponse({
    status: 204,
    description: 'The savedImage has been successfully deactivated.',
  })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_SAVED_IMAGES])
  @UseGuards(SavedImageAccessGuard)
  @Audit({
    action: AuditAction.DEACTIVATE,
    targetType: AuditTarget.SAVED_IMAGE,
    targetIdFromRequest: (req) => req.params.id,
  })
  async deactivateSavedImage(@Param('id') savedImageId: string) {
    await this.savedImageService.deactivateSavedImage(savedImageId)
  }
}
