/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  Controller,
  Body,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  ParseUUIDPipe,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { IsBoolean, IsOptional, IsString, IsInt, Min, Max, MaxLength } from 'class-validator'
import { Type } from 'class-transformer'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { PageLimit } from '../common/decorators/page-limit.decorator'
import { PageNumber } from '../common/decorators/page-number.decorator'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { CiNativeWorkers } from './ci-native-workers'
import { CiSettingsService } from './ci-settings.service'

export class CiRunnersQuery {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  name?: string
  @PageNumber(1)
  @Max(Math.floor(Number.MAX_SAFE_INTEGER / 200))
  page = 1
  @PageLimit(25)
  limit = 25
}

export class CiConnectionUpdate {
  @IsBoolean()
  allow_private_repositories!: boolean
}
export class CiRepositoryQuery {
  @PageNumber(1)
  @Max(Math.floor(Number.MAX_SAFE_INTEGER / 100))
  page = 1
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25
}

@Controller(['v1/ci', 'v1/:prefix/ci'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class CiManagementController {
  constructor(
    private readonly settings: CiSettingsService,
    private readonly workers: CiNativeWorkers,
  ) {}

  @Get('runners')
  @UseGuards(OrganizationResourceActionGuard)
  async list(@AuthContext() actor: OrganizationAuthContext, @Query() query: CiRunnersQuery) {
    const [runners, capacity] = await Promise.all([
      this.workers.list(actor.organizationId, query.page, query.limit, query.name),
      this.settings.capacity(actor.organizationId),
    ])
    return { ...runners, capacity }
  }

  @Patch('connections/:id')
  @HttpCode(204)
  @UseGuards(OrganizationActionGuard)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  @RequiredOrganizationResourcePermissions([
    OrganizationResourcePermission.WRITE_BOXES,
    OrganizationResourcePermission.DELETE_BOXES,
  ])
  update(
    @AuthContext() actor: OrganizationAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: CiConnectionUpdate,
  ) {
    return this.settings.updateConnection(actor, id, input.allow_private_repositories)
  }

  @Get('connections/:id/repositories')
  @UseGuards(OrganizationActionGuard)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  @RequiredOrganizationResourcePermissions([
    OrganizationResourcePermission.WRITE_BOXES,
    OrganizationResourcePermission.DELETE_BOXES,
  ])
  repositories(
    @AuthContext() actor: OrganizationAuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CiRepositoryQuery,
  ) {
    return this.settings.repositories(actor, id, query.page, query.limit)
  }

  @Delete('connections/:id')
  @HttpCode(204)
  @UseGuards(OrganizationActionGuard)
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  @RequiredOrganizationResourcePermissions([
    OrganizationResourcePermission.WRITE_BOXES,
    OrganizationResourcePermission.DELETE_BOXES,
  ])
  remove(@AuthContext() actor: OrganizationAuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.settings.deleteConnection(actor, id)
  }
}
