import { Body, Controller, HttpCode, Param, Post, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { BoxResizeService } from './box-resize.service'
import { ResizeBoxDto } from './dto/resize-box.dto'
import { Audit, TypedRequest } from '../audit/decorators/audit.decorator'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'

@ApiExcludeController()
@Controller(['v1/boxes', 'v1/:prefix/boxes'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
export class BoxliteResizeController {
  constructor(private readonly resize: BoxResizeService) {}

  @Post(':boxId/resize')
  @HttpCode(200)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  @Audit({
    action: AuditAction.RESIZE,
    targetType: AuditTarget.BOX,
    targetIdFromRequest: (req) => req.params.boxId,
    requestMetadata: {
      body: (req: TypedRequest<ResizeBoxDto>) => ({ cpus: req.body?.cpus, memory_mib: req.body?.memory_mib }),
    },
  })
  async resizeBox(@AuthContext() auth: OrganizationAuthContext, @Param('boxId') id: string, @Body() dto: ResizeBoxDto) {
    return this.resize.resize(id, auth.organization, dto)
  }
}
