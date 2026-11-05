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
  const member = (permissions: Permission[], keyPermissions?: Permission[]) =>
    ({
      userId: 'user',
      role: SystemRole.USER,
      organizationId: 'org',
      organization: {},
      organizationUser: { role: OrganizationMemberRole.MEMBER, assignedRoles: [{ permissions }] },
      ...(keyPermissions ? { apiKey: { organizationId: 'org', permissions: keyPermissions, keySuffix: 'abc' } } : {}),
    }) as OrganizationAuthContext

  it('uses existing member roles for reads, writes and App deletion', () => {
    const viewer = member([Permission.READ_APPS])
    expect(service.principal(viewer, 'GET', '/apps').organizationId).toBe('org')
    expect(() => service.principal(viewer, 'POST', '/apps')).toThrow(ForbiddenException)
    expect(() => service.principal(member([Permission.WRITE_APPS]), 'DELETE', '/apps/crm')).toThrow(ForbiddenException)
    expect(service.principal(member([Permission.DELETE_APPS]), 'DELETE', '/apps/crm').userId).toBe('user')
  })

  it('uses the organization key permissions for every App in the organization', () => {
    const permissions = [Permission.READ_APPS, Permission.WRITE_APPS, Permission.DELETE_APPS]
    const reader = member(permissions, [Permission.READ_APPS])
    for (const path of ['/apps', '/apps/crm', '/apps/wiki']) {
      expect(service.principal(reader, 'GET', path)).toMatchObject({ organizationId: 'org', actor: 'key:…abc' })
    }
    expect(() => service.principal(reader, 'POST', '/apps')).toThrow(ForbiddenException)
    expect(() => service.principal(reader, 'DELETE', '/apps/crm')).toThrow(ForbiddenException)
    expect(service.principal(member(permissions, [Permission.WRITE_APPS]), 'POST', '/apps').organizationId).toBe('org')
  })

  it('rejects an organization key from another organization even for an administrator', () => {
    const key = member([], [Permission.READ_APPS])
    const admin = { ...key, role: SystemRole.ADMIN, apiKey: { ...key.apiKey!, organizationId: 'other-org' } }
    expect(() => service.principal(admin, 'GET', '/apps')).toThrow(ForbiddenException)
  })

  it('honors explicit key restrictions for an administrator', () => {
    const admin = { ...member([], []), role: SystemRole.ADMIN }
    expect(() => service.principal(admin, 'GET', '/apps')).toThrow(ForbiddenException)
  })
})
