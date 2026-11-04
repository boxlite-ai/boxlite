/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
  BadRequestException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger'
import { Request, Response } from 'express'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions as Permissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { BoxCheckpointService } from '../box/services/box-checkpoint.service'
import { BoxService } from '../box/services/box.service'
import { CheckpointBoxService } from './checkpoint-box.service'
import { CheckpointTransferService } from './checkpoint-transfer.service'
import { CheckpointNameDto, CheckpointPauseDto } from './dto/checkpoint-name.dto'
import { checkpointToResponse } from './mappers/checkpoint.mapper'
import { Audit } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'

@ApiExcludeController()
@ApiBearerAuth()
@Controller(['v1/checkpoints', 'v1/:prefix/checkpoints'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteCheckpointController {
  constructor(
    private readonly checkpoints: BoxCheckpointService,
    private readonly children: CheckpointBoxService,
  ) {}

  @Get()
  async listAllCheckpoints(@AuthContext() auth: OrganizationAuthContext) {
    return { checkpoints: (await this.checkpoints.list(auth.organizationId)).map(checkpointToResponse) }
  }

  @Get(':checkpoint')
  async getAnyCheckpoint(@AuthContext() auth: OrganizationAuthContext, @Param('checkpoint') checkpoint: string) {
    return checkpointToResponse(await this.checkpoints.findOne(auth.organizationId, checkpoint))
  }

  @Delete(':checkpoint')
  @HttpCode(204)
  @Permissions([Permission.DELETE_BOXES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.CHECKPOINT,
    targetIdFromRequest: (req) => req.params.checkpoint,
  })
  async removeAnyCheckpoint(@AuthContext() auth: OrganizationAuthContext, @Param('checkpoint') checkpoint: string) {
    await this.checkpoints.remove(auth.organizationId, checkpoint)
  }

  @Post(':checkpoint/boxes')
  @HttpCode(201)
  @Permissions([Permission.WRITE_BOXES])
  @Audit({ action: AuditAction.CREATE, targetType: AuditTarget.BOX, targetIdFromResult: (result) => result?.box_id })
  async createBoxFromCheckpoint(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('checkpoint') checkpoint: string,
    @Body() body: CheckpointNameDto,
  ) {
    return this.children.create(auth, await this.checkpoints.findOne(auth.organizationId, checkpoint), body.name)
  }
}

@ApiExcludeController()
@ApiBearerAuth()
@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteBoxCheckpointController {
  constructor(
    private readonly checkpoints: BoxCheckpointService,
    private readonly boxes: BoxService,
    private readonly transfers: CheckpointTransferService,
  ) {}

  @Post('checkpoint/import')
  @HttpCode(201)
  @Permissions([Permission.WRITE_BOXES])
  @Audit({ action: AuditAction.CREATE, targetType: AuditTarget.BOX, targetIdFromResult: (result) => result?.box_id })
  async importCheckpoint(
    @AuthContext() auth: OrganizationAuthContext,
    @Query() query: CheckpointNameDto,
    @Req() request: Request,
  ) {
    if (!request.is(['application/zstd', 'application/octet-stream']))
      throw new BadRequestException('Checkpoint import requires application/zstd or application/octet-stream')
    return this.transfers.import(auth, request, query.name)
  }

  @Post(':boxId/checkpoint/export')
  @HttpCode(200)
  @Permissions([Permission.WRITE_BOXES])
  async exportCheckpoint(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('boxId') box: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    await this.transfers.export(auth, box, request, response)
  }

  @Post(':boxId/pause')
  @HttpCode(204)
  @Permissions([Permission.WRITE_BOXES])
  async pauseBox(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('boxId') box: string,
    @Body() body: CheckpointPauseDto,
  ) {
    if (body.host_writers_stopped !== undefined && typeof body.host_writers_stopped !== 'boolean')
      throw new BadRequestException('host_writers_stopped must be boolean')
    await this.checkpoints.pause(box, auth.organizationId)
  }

  @Post(':boxId/resume')
  @HttpCode(204)
  @Permissions([Permission.WRITE_BOXES])
  async resumeBox(@AuthContext() auth: OrganizationAuthContext, @Param('boxId') box: string) {
    await this.checkpoints.resume(box, auth.organizationId)
  }

  @Post(':boxId/checkpoints')
  @HttpCode(201)
  @Permissions([Permission.WRITE_BOXES])
  @Audit({ action: AuditAction.CREATE, targetType: AuditTarget.CHECKPOINT, targetIdFromResult: (result) => result?.id })
  async createCheckpoint(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('boxId') box: string,
    @Body() body: CheckpointNameDto,
  ) {
    return checkpointToResponse(await this.checkpoints.create(box, body.name, auth.organizationId))
  }

  @Get(':boxId/checkpoints')
  async listCheckpoints(@AuthContext() auth: OrganizationAuthContext, @Param('boxId') box: string) {
    return {
      checkpoints: (await this.checkpoints.list(auth.organizationId, await this.scope(auth, box))).map(
        checkpointToResponse,
      ),
    }
  }

  @Get(':boxId/checkpoints/:checkpoint')
  async getCheckpoint(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('boxId') box: string,
    @Param('checkpoint') checkpoint: string,
  ) {
    return checkpointToResponse(
      await this.checkpoints.findOne(auth.organizationId, checkpoint, await this.scope(auth, box)),
    )
  }

  @Delete(':boxId/checkpoints/:checkpoint')
  @HttpCode(204)
  @Permissions([Permission.DELETE_BOXES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.CHECKPOINT,
    targetIdFromRequest: (req) => req.params.checkpoint,
  })
  async removeCheckpoint(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('boxId') box: string,
    @Param('checkpoint') checkpoint: string,
  ) {
    await this.checkpoints.remove(auth.organizationId, checkpoint, await this.scope(auth, box))
  }

  private async scope(auth: OrganizationAuthContext, selector: string) {
    return { sourceBoxId: (await this.boxes.findOneByIdOrName(selector, auth.organizationId)).id }
  }
}
