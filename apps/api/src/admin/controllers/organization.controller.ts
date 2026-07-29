/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Audit, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationUsageService } from '../../organization/services/organization-usage.service'
import { AdminOrganizationQuotaDto, AdminUpdateOrganizationQuotaDto } from '../dto/organization-quota.dto'

@ApiTags('admin')
@Controller('admin/organizations')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminOrganizationController {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly organizationUsageService: OrganizationUsageService,
  ) {}

  @Get(':organizationId/quota')
  @ApiOperation({
    summary: 'Get organization quota',
    operationId: 'adminGetOrganizationQuota',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiResponse({ status: 200, type: AdminOrganizationQuotaDto })
  async getQuota(@Param('organizationId', ParseUUIDPipe) organizationId: string): Promise<AdminOrganizationQuotaDto> {
    await this.assertOrganizationExists(organizationId)

    const limits = await this.organizationUsageService.getQuotaLimits(organizationId)
    const customized = await this.organizationUsageService.hasCustomQuota(organizationId)

    return { ...limits, customized }
  }

  @Patch(':organizationId/quota')
  @ApiOperation({
    summary: 'Update organization quota',
    operationId: 'adminUpdateOrganizationQuota',
  })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiResponse({ status: 200, type: AdminOrganizationQuotaDto })
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.ORGANIZATION,
    targetIdFromRequest: (req: TypedRequest<AdminUpdateOrganizationQuotaDto>) => req.params?.organizationId,
    requestMetadata: {
      body: (req: TypedRequest<AdminUpdateOrganizationQuotaDto>) => ({
        totalCpuQuota: req.body?.totalCpuQuota,
        totalMemoryQuota: req.body?.totalMemoryQuota,
        totalDiskQuota: req.body?.totalDiskQuota,
        totalGpuQuota: req.body?.totalGpuQuota,
        maxConcurrentBoxes: req.body?.maxConcurrentBoxes,
        maxVolumes: req.body?.maxVolumes,
      }),
    },
  })
  async updateQuota(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: AdminUpdateOrganizationQuotaDto,
  ): Promise<AdminOrganizationQuotaDto> {
    await this.assertOrganizationExists(organizationId)

    const limits = await this.organizationUsageService.updateQuotaLimits(organizationId, dto)

    return { ...limits, customized: true }
  }

  /**
   * A quota row is keyed by organization id but has no foreign-key-checked insert
   * path here, so an unknown id would otherwise read back the built-in defaults —
   * or write a quota row for an organization that does not exist.
   */
  private async assertOrganizationExists(organizationId: string): Promise<void> {
    const organization = await this.organizationService.findOne(organizationId)
    if (!organization) {
      throw new NotFoundException(`Organization with ID ${organizationId} not found`)
    }
  }
}
