// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import {
  Body,
  Controller,
  Delete,
  DefaultValuePipe,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Checkpoint } from '../box/entities/checkpoint.entity'
import { CheckpointService } from '../box/services/checkpoint.service'

class CreateCheckpointRequest {
  @IsString() @MinLength(1) @MaxLength(128) source_box_id: string
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/) name?: string
}

@Controller(['v1/checkpoints', 'v1/:prefix/checkpoints'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteCheckpointController {
  constructor(private readonly checkpoints: CheckpointService) {}

  @Post()
  @HttpCode(201)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async create(@AuthContext() auth: OrganizationAuthContext, @Body() request: CreateCheckpointRequest) {
    return response(
      await this.checkpoints.create(auth.organizationId, request.source_box_id, request.name ?? undefined),
    )
  }

  @Get()
  async list(@AuthContext() auth: OrganizationAuthContext, @Query('page_token') pageToken?: string) {
    const page = await this.checkpoints.list(auth.organizationId, pageToken)
    return { checkpoints: page.checkpoints.map(response), next_page_token: page.nextPageToken }
  }

  @Get(':key')
  async get(@AuthContext() auth: OrganizationAuthContext, @Param('key') key: string) {
    return response(await this.checkpoints.get(auth.organizationId, key))
  }

  @Delete(':key')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  async remove(
    @AuthContext() auth: OrganizationAuthContext,
    @Param('key') key: string,
    @Query('force', new DefaultValuePipe(false), ParseBoolPipe) force: unknown,
  ) {
    // Boolean metatype coercion would turn an invalid query into false before
    // ParseBoolPipe can reject it. Let that pipe validate the original value.
    await this.checkpoints.remove(auth.organizationId, key, force === true)
  }
}

function response(checkpoint: Checkpoint) {
  return {
    id: checkpoint.id,
    name: checkpoint.name,
    source_box_id: checkpoint.sourceBoxId,
    state: checkpoint.state,
    created_at: checkpoint.createdAt.toISOString(),
    size_bytes: checkpoint.archive?.sizeBytes ?? 0,
    ...(checkpoint.errorReason ? { error_reason: checkpoint.errorReason } : {}),
  }
}
