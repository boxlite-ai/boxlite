import { ApiProperty } from '@nestjs/swagger'
import { IsArray, IsIn } from 'class-validator'
import {
  APP_HOSTING_PERMISSIONS,
  OrganizationResourcePermission,
} from '../../organization/enums/organization-resource-permission.enum'

export class OrganizationAppHostingPermissionsDto {
  @ApiProperty({
    enum: APP_HOSTING_PERMISSIONS,
    isArray: true,
    description: 'App Hosting scopes enabled for the organization. An empty list disables access.',
  })
  @IsArray()
  @IsIn(APP_HOSTING_PERMISSIONS, { each: true })
  appHostingPermissions: OrganizationResourcePermission[]
}
