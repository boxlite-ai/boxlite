import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { RequiredOrganizationResourcePermissions } from '../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { CreateBoxDto } from './dto/create-box.dto'
import { SnapshotService } from './snapshot.service'

export class SnapshotChildDto {
  @IsOptional() @IsString() name?: string
  @IsOptional() @ValidateNested() @Type(() => CreateBoxDto) options?: CreateBoxDto
}

export class SnapshotCopyDto {
  @IsUUID() runner_id: string
  @IsOptional() @IsString() @MaxLength(255) @Matches(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/) name?: string
}

@ApiExcludeController()
@Controller(['v1/snapshots', 'v1/:prefix/snapshots'])
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
export class BoxliteSnapshotController {
  constructor(private readonly snapshots: SnapshotService) {}
  @Get(':id')
  get(@AuthContext() auth: OrganizationAuthContext, @Param('id') id: string) {
    return this.snapshots.get(auth, id)
  }
  @Delete(':id')
  @HttpCode(204)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  remove(@AuthContext() auth: OrganizationAuthContext, @Param('id') id: string) {
    return this.snapshots.remove(auth, id)
  }
  @Post(':id/copies')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  copy(@AuthContext() auth: OrganizationAuthContext, @Param('id') id: string, @Body() body: SnapshotCopyDto) {
    return this.snapshots.copy(auth, id, body.runner_id, body.name)
  }
  @Post(':id/boxes')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_BOXES])
  create(@AuthContext() auth: OrganizationAuthContext, @Param('id') id: string, @Body() body: SnapshotChildDto) {
    return this.snapshots.createBox(auth, id, body.name, body.options)
  }
}
