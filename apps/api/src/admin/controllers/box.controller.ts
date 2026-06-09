/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, HttpCode, NotFoundException, Param, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { OrganizationService } from '../../organization/services/organization.service'
import { BoxDto } from '../../box/dto/box.dto'
import { BoxService } from '../../box/services/box.service'
import { SystemRole } from '../../user/enums/system-role.enum'

@ApiTags('admin')
@Controller('admin/box')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
export class AdminBoxController {
  constructor(
    private readonly boxService: BoxService,
    private readonly organizationService: OrganizationService,
  ) {}

  @Post(':boxId/recover')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Recover box from error state as an admin',
    operationId: 'adminRecoverBox',
  })
  @ApiParam({
    name: 'boxId',
    description: 'ID of the box',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Recovery initiated',
    type: BoxDto,
  })
  @Audit({
    action: AuditAction.RECOVER,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    targetIdFromResult: (result: BoxDto) => result?.id,
  })
  async recoverBox(@Param('boxId') boxId: string): Promise<BoxDto> {
    const organization = await this.organizationService.findByBoxId(boxId)
    if (!organization) {
      throw new NotFoundException('Box not found')
    }
    const recoveredBox = await this.boxService.recover(boxId, organization)
    return this.boxService.toBoxDto(recoveredBox)
  }
}
