/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Body, Controller, Get, Patch, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { IsInt, Max, Min, ValidateIf } from 'class-validator'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationActionGuard } from '../organization/guards/organization-action.guard'
import { RequiredOrganizationMemberRole } from '../organization/decorators/required-organization-member-role.decorator'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { CiSettingsService } from './ci-settings.service'

export class CiSettingsInput {
  @ValidateIf((_object, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  max_concurrent_jobs: number | null
}

@Controller(['v1/ci/settings', 'v1/:prefix/ci/settings'])
@ApiExcludeController()
@UseGuards(CombinedAuthGuard, AuthenticatedRateLimitGuard, OrganizationActionGuard)
@RequiredOrganizationResourcePermissions([
  OrganizationResourcePermission.WRITE_BOXES,
  OrganizationResourcePermission.DELETE_BOXES,
])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class CiSettingsController {
  constructor(private readonly settings: CiSettingsService) {}
  @Get()
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  get(@AuthContext() actor: OrganizationAuthContext) {
    return this.settings.get(actor)
  }
  @Patch()
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  update(@AuthContext() actor: OrganizationAuthContext, @Body() input: CiSettingsInput) {
    return this.settings.update(actor, input.max_concurrent_jobs)
  }
}
