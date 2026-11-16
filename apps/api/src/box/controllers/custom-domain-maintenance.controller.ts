/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { CustomDomainWorkflowService } from '../services/custom-domain-workflow.service'

@ApiExcludeController()
@Controller('admin/custom-domains')
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
export class CustomDomainMaintenanceController {
  constructor(private readonly workflow: CustomDomainWorkflowService) {}

  @Post('maintain')
  @HttpCode(204)
  async maintain(): Promise<void> {
    await this.workflow.maintain()
  }
}
