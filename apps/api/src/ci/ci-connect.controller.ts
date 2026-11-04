/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { Equals, IsBoolean, IsString, Matches, MaxLength } from 'class-validator'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { CiConnectService } from './ci-connect.service'

export class CiConnectInput {
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
  github_account: string
  @Equals(true)
  follow_installation: true
  @IsBoolean()
  allow_public_repositories: boolean
}

export class CiWebCompleteInput {
  @IsString()
  @MaxLength(2048)
  @Matches(/^[\x21-\x7e]+$/)
  code: string
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/)
  state: string
}

@Controller(['v1/ci/connect', 'v1/:prefix/ci/connect'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, OrganizationActionGuard)
@RequiredOrganizationResourcePermissions([
  OrganizationResourcePermission.WRITE_BOXES,
  OrganizationResourcePermission.DELETE_BOXES,
])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class CiConnectController {
  constructor(private readonly service: CiConnectService) {}
  @Post()
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  start(@AuthContext() actor: OrganizationAuthContext, @Body() body: CiConnectInput) {
    return this.service.start(actor, body)
  }

  @Get('configuration')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  configuration() {
    return this.service.configuration()
  }

  @Post('web')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  startWeb(@AuthContext() actor: OrganizationAuthContext, @Body() body: CiConnectInput) {
    return this.service.startWeb(actor, body)
  }

  @Post(':id/complete')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  completeWeb(
    @AuthContext() actor: OrganizationAuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: CiWebCompleteInput,
  ) {
    return this.service.completeWeb(actor, id, body)
  }

  @Post(':id/poll')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  poll(@AuthContext() actor: OrganizationAuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.poll(actor, id)
  }

  @Delete(':id')
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  cancel(@AuthContext() actor: OrganizationAuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.service.cancel(actor, id)
  }
}
