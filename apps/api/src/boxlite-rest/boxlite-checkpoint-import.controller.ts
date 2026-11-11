// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpException,
  Post,
  Res,
  UnsupportedMediaTypeException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { NotContains, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator'
import type { Response } from 'express'
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

class ImportCheckpointRequest {
  @IsString() @MinLength(1) @MaxLength(128) checkpoint_id: string

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  name?: string

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @NotContains('\0')
  box_id?: string
}

@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteCheckpointImportController {
  constructor(
    private readonly recovery: CheckpointRecoverService,
    private readonly waiter: BoxStateWaiterService,
    private readonly limits: CommerceBoxLimitService,
  ) {}

  @Post('import')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async importBox(
    @AuthContext() auth: OrganizationAuthContext,
    @Headers('content-type') contentType: string | undefined,
    @Body() request: ImportCheckpointRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      throw new UnsupportedMediaTypeException('Cloud import requires a JSON checkpoint selector')
    }
    if (request.name !== undefined && request.box_id !== undefined) {
      throw new BadRequestException('name and box_id are mutually exclusive')
    }
    const maxCreatedBoxes = await this.limits.resolveMaxCreatedBoxes(auth.organizationId)
    const replacing = request.box_id !== undefined
    const box = replacing
      ? await this.recovery.recover(auth.organization, request.checkpoint_id, request.box_id, maxCreatedBoxes)
      : await this.recovery.createBox(auth.organization, request.checkpoint_id, request.name, maxCreatedBoxes)
    response.status(replacing ? 200 : 201)
    try {
      const imported =
        !replacing || box.desiredState === BoxDesiredState.STARTED
          ? await this.waiter.waitForStarted(box.id, auth.organizationId, 30)
          : await this.waiter.waitForStopped(box.id, auth.organizationId, 30)
      return boxToBoxResponse(imported)
    } catch (error) {
      // Admission already created or reserved this identity. Clients must query
      // it after any wait failure instead of submitting another anonymous Box.
      const status = error instanceof HttpException ? error.getStatus() : 500
      const detail = error instanceof HttpException ? error.getResponse() : 'Checkpoint import failed'
      throw new HttpException(
        { ...(typeof detail === 'string' ? { message: detail } : detail), boxId: box.id },
        status,
        { cause: error },
      )
    }
  }
}
