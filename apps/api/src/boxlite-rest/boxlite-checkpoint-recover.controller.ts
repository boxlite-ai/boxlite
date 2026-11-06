// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { Body, Controller, HttpCode, Param, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { IsString, MaxLength, MinLength } from 'class-validator'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { boxToBoxResponse } from './mappers/box-to-box.mapper'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'

class RecoverCheckpointRequest {
  @IsString() @MinLength(1) @MaxLength(128) checkpoint_id: string
}

@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteCheckpointRecoverController {
  constructor(
    private readonly recovery: CheckpointRecoverService,
    private readonly waiter: BoxStateWaiterService,
    private readonly limits: CommerceBoxLimitService,
  ) {}

  @Post(':target/recover')
  @HttpCode(200)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async recover(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('target') target: string,
    @Body() request: RecoverCheckpointRequest,
  ) {
    const maxCreatedBoxes = await this.limits.resolveMaxCreatedBoxes(auth.organizationId)
    const box = await this.recovery.recover(auth.organization, request.checkpoint_id, target, maxCreatedBoxes)
    const recovered =
      box.desiredState === BoxDesiredState.STARTED
        ? await this.waiter.waitForStarted(box.id, auth.organizationId, 30)
        : await this.waiter.waitForStopped(box.id, auth.organizationId, 30)
    return boxToBoxResponse(recovered)
  }
}
