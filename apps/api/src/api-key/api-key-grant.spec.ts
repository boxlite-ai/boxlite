/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiKey } from './api-key.entity'
import { grantablePermissions, ungrantablePermissions } from './api-key-grant'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../organization/enums/organization-resource-permission.enum'
import { SystemRole } from '../user/enums/system-role.enum'

const VOLUME_LIFECYCLE = [
  OrganizationResourcePermission.READ_VOLUMES,
  OrganizationResourcePermission.WRITE_VOLUMES,
  OrganizationResourcePermission.DELETE_VOLUMES,
]

function context(overrides: Partial<OrganizationAuthContext>): OrganizationAuthContext {
  return {
    userId: 'user-1',
    email: 'dev@example.com',
    role: SystemRole.USER,
    organizationId: 'org-1',
    organization: { id: 'org-1' },
    ...overrides,
  } as OrganizationAuthContext
}

function keyContext(permissions: OrganizationResourcePermission[]): OrganizationAuthContext {
  return context({
    apiKey: { permissions } as ApiKey,
    // Every API key belongs to a member; owner here so the assertions cannot
    // pass by falling through to the membership rule.
    organizationUser: { role: OrganizationMemberRole.OWNER, assignedRoles: [] },
  } as Partial<OrganizationAuthContext>)
}

describe('grantablePermissions', () => {
  it('bounds an API key by the permissions it carries, not by its owner role', () => {
    expect(grantablePermissions(keyContext(VOLUME_LIFECYCLE))).toEqual(VOLUME_LIFECYCLE)
  })

  it('lets a system admin grant anything', () => {
    expect(grantablePermissions(context({ role: SystemRole.ADMIN }))).toBeNull()
  })

  it('lets an interactive owner grant anything', () => {
    const owner = context({
      organizationUser: { role: OrganizationMemberRole.OWNER, assignedRoles: [] },
    } as Partial<OrganizationAuthContext>)

    expect(grantablePermissions(owner)).toBeNull()
  })

  it('bounds an interactive member by the roles assigned to them', () => {
    const member = context({
      organizationUser: {
        role: OrganizationMemberRole.MEMBER,
        assignedRoles: [{ permissions: [OrganizationResourcePermission.READ_VOLUMES] }],
      },
    } as Partial<OrganizationAuthContext>)

    expect(grantablePermissions(member)).toEqual([OrganizationResourcePermission.READ_VOLUMES])
  })

  it('grants nothing to a caller with no membership', () => {
    expect(grantablePermissions(context({}))).toEqual([])
  })
})

describe('ungrantablePermissions', () => {
  it('lets a volume key mint the full volume lifecycle', () => {
    expect(ungrantablePermissions(keyContext(VOLUME_LIFECYCLE), VOLUME_LIFECYCLE)).toEqual([])
  })

  it('refuses the permissions the calling key does not hold', () => {
    const boxesOnly = keyContext([
      OrganizationResourcePermission.WRITE_BOXES,
      OrganizationResourcePermission.DELETE_BOXES,
    ])

    expect(ungrantablePermissions(boxesOnly, VOLUME_LIFECYCLE)).toEqual(VOLUME_LIFECYCLE)
  })

  it('names only the refused subset, so the caller can narrow the request', () => {
    const readOnly = keyContext([OrganizationResourcePermission.READ_VOLUMES])

    expect(ungrantablePermissions(readOnly, VOLUME_LIFECYCLE)).toEqual([
      OrganizationResourcePermission.WRITE_VOLUMES,
      OrganizationResourcePermission.DELETE_VOLUMES,
    ])
  })

  it('lets a key mint a narrower key than itself', () => {
    expect(ungrantablePermissions(keyContext(VOLUME_LIFECYCLE), [OrganizationResourcePermission.READ_VOLUMES])).toEqual(
      [],
    )
  })
})
