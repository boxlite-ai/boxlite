import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { Audit, AUDIT_RESULT_METADATA } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { OrganizationService } from '../../organization/services/organization.service'
import { SystemRole } from '../../user/enums/system-role.enum'
import { OrganizationAppHostingPermissionsDto } from '../dto/organization-app-hosting-permissions.dto'

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/organizations/:organizationId/app-hosting-permissions')
@ApiParam({ name: 'organizationId', type: String, format: 'uuid' })
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class AdminOrganizationAppHostingPermissionsController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminGetOrganizationAppHostingPermissions',
    summary: 'Read organization App Hosting permissions',
  })
  @ApiOkResponse({ type: OrganizationAppHostingPermissionsDto })
  async get(@Param('organizationId', ParseUUIDPipe) id: string): Promise<OrganizationAppHostingPermissionsDto> {
    return { appHostingPermissions: await this.organizations.getAppHostingPermissions(id) }
  }

  @Put()
  @ApiOperation({
    operationId: 'adminSetOrganizationAppHostingPermissions',
    summary: 'Replace organization App Hosting permissions',
  })
  @ApiOkResponse({ type: OrganizationAppHostingPermissionsDto })
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.ORGANIZATION,
    organizationIdFromRequest: (req) => req.params.organizationId,
    targetIdFromRequest: (req) => req.params.organizationId,
    requestMetadata: { correlationId: (req) => req.get('X-Correlation-ID') },
  })
  async put(
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Body() body: OrganizationAppHostingPermissionsDto,
    @Req() request: Request,
  ): Promise<OrganizationAppHostingPermissionsDto> {
    const change = await this.organizations.setAppHostingPermissions(id, body.appHostingPermissions)
    request[AUDIT_RESULT_METADATA] = change
    return { appHostingPermissions: change.after }
  }
}
