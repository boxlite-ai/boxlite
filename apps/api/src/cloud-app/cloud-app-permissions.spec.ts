import { ForbiddenException } from '@nestjs/common'
import { CloudAppService } from './cloud-app.service'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'
import { Organization } from '../organization/entities/organization.entity'
import { appRoutePermissions } from './cloud-app-route-permissions'
import { createServer } from './engine/server'
import type { Ctx } from './engine/ctx'

describe('App management organization permissions', () => {
  const service = Object.assign(Object.create(CloudAppService.prototype), {
    organizations: { assertOrganizationIsNotSuspended: jest.fn() },
  }) as CloudAppService
  const member = (permissions: Permission[], keyPermissions?: Permission[]) =>
    ({
      userId: 'user',
      email: 'user@example.test',
      role: SystemRole.USER,
      organizationId: 'org',
      organization: Object.assign(new Organization(), {
        id: 'org',
        appHostingPermissions: [Permission.READ_APPS, Permission.WRITE_APPS, Permission.DELETE_APPS],
      }),
      organizationUser: { role: OrganizationMemberRole.MEMBER, assignedRoles: [{ permissions }] },
      ...(keyPermissions ? { apiKey: { organizationId: 'org', permissions: keyPermissions, keySuffix: 'abc' } } : {}),
    }) as unknown as OrganizationAuthContext

  it.each([false, true])('requires organization authorization for a previously granted scope (key=%s)', (key) => {
    const grants = [Permission.READ_APPS, Permission.WRITE_APPS, Permission.DELETE_APPS]
    const auth = member(grants, key ? grants : undefined)
    Object.assign(auth.organization, { appHostingPermissions: [] })
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(() => service.principal(auth, method, '/apps/example')).toThrow(ForbiddenException)
    }
    Object.assign(auth.organization, { appHostingPermissions: [Permission.READ_APPS] })
    expect(service.principal(auth, 'GET', '/apps/example').permissions).toEqual([Permission.READ_APPS])
    expect(() => service.principal(auth, 'POST', '/apps/example/restart')).toThrow(ForbiddenException)
  })

  it('uses existing member roles for reads, writes and App deletion', () => {
    const viewer = member([Permission.READ_APPS])
    expect(service.principal(viewer, 'GET', '/apps').organizationId).toBe('org')
    expect(() => service.principal(viewer, 'POST', '/apps')).toThrow(ForbiddenException)
    expect(() => service.principal(member([Permission.WRITE_APPS]), 'DELETE', '/apps/crm')).toThrow(ForbiddenException)
    expect(service.principal(member([Permission.DELETE_APPS]), 'DELETE', '/apps/crm').userId).toBe('user')
    expect(service.principal(member([Permission.DELETE_APPS]), 'DELETE', '/apps/deleted/crm').permissions).toContain(
      Permission.DELETE_APPS,
    )
    expect(() => service.principal(member([Permission.WRITE_APPS]), 'DELETE', '/apps/deleted/crm')).toThrow(
      ForbiddenException,
    )
  })

  it('uses the organization key permissions for every App in the organization', () => {
    const permissions = [Permission.READ_APPS, Permission.WRITE_APPS, Permission.DELETE_APPS]
    const reader = member(permissions, [Permission.READ_APPS])
    for (const path of ['/apps', '/apps/crm', '/apps/wiki']) {
      expect(service.principal(reader, 'GET', path)).toMatchObject({ organizationId: 'org', actor: 'key:…abc' })
    }
    expect(() => service.principal(reader, 'POST', '/apps')).toThrow(ForbiddenException)
    expect(() => service.principal(reader, 'DELETE', '/apps/crm')).toThrow(ForbiddenException)
    expect(() => service.principal(reader, 'DELETE', '/apps/deleted/crm')).toThrow(ForbiddenException)
    expect(service.principal(member(permissions, [Permission.WRITE_APPS]), 'POST', '/apps').organizationId).toBe('org')
    const files = '/apps/crm/envs/main/volumes/uploads/files'
    const writer = member(permissions, [Permission.WRITE_APPS])
    expect(service.principal(reader, 'GET', files).organizationId).toBe('org')
    for (const method of ['PUT', 'DELETE']) {
      expect(() => service.principal(reader, method, files)).toThrow(ForbiddenException)
      expect(service.principal(writer, method, files).organizationId).toBe('org')
    }
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

  it('declares a scope for every mounted App management handler', () => {
    const server = createServer({ config: {}, store: {} } as Ctx)
    const missing: string[] = []
    for (const { method, path } of server.routes) {
      if (method === 'ALL' || !(path.startsWith('/v1/apps') || path === '/cli/version')) continue
      const sample = path
        .replace(/^\/v1/, '')
        .replace(/:(\w+)(?:\{[^}]+\})?/g, (_, name: string) => (name === 'op' ? 'block' : '1'))
      if (!appRoutePermissions(method, sample).length) missing.push(`${method} ${path}`)
    }
    expect(missing).toEqual([])
  })

  it('denies undeclared operations even to a fully invited owner', () => {
    const auth = member([Permission.READ_APPS, Permission.WRITE_APPS, Permission.DELETE_APPS])
    auth.organizationUser.role = OrganizationMemberRole.OWNER
    for (const [method, path] of [
      ['PATCH', '/apps/crm'],
      ['GET', '/apps/crm/unsupported'],
    ]) {
      expect(() => service.principal(auth, method, path)).toThrow(ForbiddenException)
    }
    expect(appRoutePermissions('HEAD', '/apps/crm/view')).toEqual([Permission.READ_APPS])
  })
})
