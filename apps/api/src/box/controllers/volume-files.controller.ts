/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { VolumeAccessGuard } from '../guards/volume-access.guard'
import { VolumeFilesService } from '../services/volume-files.service'
import {
  BatchDeleteVolumeFilesDto,
  BatchDeleteVolumeFilesResponseDto,
  ListVolumeFilesResponseDto,
  PresignBatchWriteVolumeFilesDto,
  PresignBatchWriteVolumeFilesResponseDto,
  PresignedUrlResponseDto,
  VolumeFileStatDto,
} from '../dto/volume-file.dto'

@ApiTags('volumes')
@Controller('volumes/:volumeId/files')
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard, AuthenticatedRateLimitGuard, VolumeAccessGuard)
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@ApiParam({ name: 'volumeId', description: 'ID of the volume', type: 'string' })
export class VolumeFilesController {
  constructor(private readonly volumeFilesService: VolumeFilesService) {}

  @Get()
  @ApiOperation({ summary: 'List files under a path in a volume', operationId: 'listVolumeFiles' })
  @ApiResponse({ status: 200, type: ListVolumeFilesResponseDto })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_VOLUMES])
  async listFiles(
    @Param('volumeId') volumeId: string,
    @Query('path') path = '',
    @Query('cursor') cursor?: string,
  ): Promise<ListVolumeFilesResponseDto> {
    return this.volumeFilesService.listFiles(volumeId, path, cursor)
  }

  @Get('stat')
  @ApiOperation({ summary: 'Get metadata for a single file in a volume', operationId: 'statVolumeFile' })
  @ApiResponse({ status: 200, type: VolumeFileStatDto })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_VOLUMES])
  async statFile(@Param('volumeId') volumeId: string, @Query('path') path: string): Promise<VolumeFileStatDto> {
    return this.volumeFilesService.statFile(volumeId, path)
  }

  @Get('presign-read')
  @ApiOperation({
    summary: 'Get a short-lived URL to read a file directly from object storage',
    operationId: 'presignReadVolumeFile',
  })
  @ApiResponse({ status: 200, type: PresignedUrlResponseDto })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_VOLUMES])
  async presignRead(
    @Param('volumeId') volumeId: string,
    @Query('path') path: string,
  ): Promise<PresignedUrlResponseDto> {
    return this.volumeFilesService.presignRead(volumeId, path)
  }

  @Post('presign-write')
  @ApiOperation({
    summary: 'Get a short-lived URL to write a file directly to object storage',
    operationId: 'presignWriteVolumeFile',
  })
  @ApiResponse({ status: 200, type: PresignedUrlResponseDto })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_VOLUMES])
  async presignWrite(
    @Param('volumeId') volumeId: string,
    @Query('path') path: string,
  ): Promise<PresignedUrlResponseDto> {
    return this.volumeFilesService.presignWrite(volumeId, path)
  }

  @Delete('content')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a single file from a volume', operationId: 'deleteVolumeFile' })
  @ApiResponse({ status: 204, description: 'File deleted' })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_VOLUMES])
  async deleteFile(@Param('volumeId') volumeId: string, @Query('path') path: string): Promise<void> {
    await this.volumeFilesService.deleteFile(volumeId, path)
  }

  @Post('batch-delete')
  @ApiOperation({ summary: 'Delete a batch of files from a volume', operationId: 'batchDeleteVolumeFiles' })
  @ApiResponse({ status: 200, type: BatchDeleteVolumeFilesResponseDto })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_VOLUMES])
  async batchDelete(
    @Param('volumeId') volumeId: string,
    @Body() dto: BatchDeleteVolumeFilesDto,
  ): Promise<BatchDeleteVolumeFilesResponseDto> {
    return this.volumeFilesService.batchDelete(volumeId, dto.paths)
  }

  @Post('presign-batch-write')
  @ApiOperation({
    summary: 'Get short-lived URLs to write a batch of files directly to object storage',
    operationId: 'presignBatchWriteVolumeFiles',
  })
  @ApiResponse({ status: 200, type: PresignBatchWriteVolumeFilesResponseDto })
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_VOLUMES])
  async presignBatchWrite(
    @Param('volumeId') volumeId: string,
    @Body() dto: PresignBatchWriteVolumeFilesDto,
  ): Promise<PresignBatchWriteVolumeFilesResponseDto> {
    return this.volumeFilesService.presignBatchWrite(volumeId, dto.paths)
  }
}
