import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import { Audit, TypedRequest } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { OrganizationService } from '../../organization/services/organization.service'
import { SystemRole } from '../../user/enums/system-role.enum'
import { AdminOrganizationNestedVirtualizationDto } from '../dto/organization-nested-virtualization.dto'

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/organizations/:organizationId/nested-virtualization')
@ApiParam({ name: 'organizationId', type: String, format: 'uuid' })
@UseGuards(CombinedAuthGuard, SystemActionGuard)
@RequiredApiRole([SystemRole.ADMIN])
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class AdminOrganizationNestedVirtualizationController {
  constructor(private readonly organizations: OrganizationService) {}

  @Get()
  @ApiOperation({
    operationId: 'adminGetOrganizationNestedVirtualization',
    summary: 'Read organization nesting allowlist',
  })
  @ApiOkResponse({ type: AdminOrganizationNestedVirtualizationDto })
  async get(@Param('organizationId', ParseUUIDPipe) id: string): Promise<AdminOrganizationNestedVirtualizationDto> {
    const organization = await this.organizations.findOne(id)
    if (!organization) throw new NotFoundException('Organization not found')
    return { enabled: organization.nestedVirtualizationEnabled === true }
  }

  @Put()
  @ApiBody({
    schema: {
      type: 'object',
      required: ['enabled'],
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Allow new boxes to use nesting when their selected Runner supports it.',
        },
      },
    },
  })
  @ApiOperation({
    operationId: 'adminSetOrganizationNestedVirtualization',
    summary: 'Set organization nesting allowlist',
  })
  @ApiOkResponse({ type: AdminOrganizationNestedVirtualizationDto })
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.ORGANIZATION,
    organizationIdFromRequest: (req) => req.params.organizationId,
    targetIdFromRequest: (req) => req.params.organizationId,
    requestMetadata: {
      body: (req: TypedRequest<AdminOrganizationNestedVirtualizationDto>) => ({ enabled: req.body?.enabled }),
    },
  })
  async put(
    @Param('organizationId', ParseUUIDPipe) id: string,
    @Body() body: AdminOrganizationNestedVirtualizationDto,
  ): Promise<AdminOrganizationNestedVirtualizationDto> {
    await this.organizations.setNestedVirtualizationEnabled(id, body.enabled)
    return { enabled: body.enabled }
  }
}
