import { ForbiddenException } from '@nestjs/common'
import { CloudAppService } from './cloud-app.service'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'

describe('App management organization permissions', () => {
  const service = Object.assign(Object.create(CloudAppService.prototype), {
    organizations: { assertOrganizationIsNotSuspended: jest.fn() },
  }) as CloudAppService
  const member = (permissions: Permission[], cloudAppId?: string) =>
    ({
      userId: 'user',
      role: SystemRole.USER,
      organizationId: 'org',
      organization: {},
      organizationUser: { role: OrganizationMemberRole.MEMBER, assignedRoles: [{ permissions }] },
      ...(cloudAppId ? { apiKey: { cloudAppId, permissions, keySuffix: 'abc' } } : {}),
    }) as OrganizationAuthContext

  it('uses existing member roles for reads, writes and App deletion', () => {
    const viewer = member([Permission.READ_APPS])
    expect(service.principal(viewer, 'GET', '/apps').organizationId).toBe('org')
    expect(() => service.principal(viewer, 'POST', '/apps')).toThrow(ForbiddenException)
    expect(() => service.principal(member([Permission.WRITE_APPS]), 'DELETE', '/apps/crm')).toThrow(ForbiddenException)
    expect(service.principal(member([Permission.DELETE_APPS]), 'DELETE', '/apps/crm').userId).toBe('user')
  })

  it('confines an agent credential to App routes and cannot mint more credentials', () => {
    const agent = member([Permission.READ_APPS, Permission.WRITE_APPS], 'app_crm')
    expect(service.principal(agent, 'GET', '/apps/me/whoami').appId).toBe('app_crm')
    for (const path of ['/apps', '/apps/deleted', '/apps/crm/keys']) {
      expect(() => service.principal(agent, 'POST', path)).toThrow(ForbiddenException)
    }
  })
})
