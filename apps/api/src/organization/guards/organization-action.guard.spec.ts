/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid'), validate: jest.fn(() => true) }))

import { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { RequiredOrganizationMemberRole } from '../decorators/required-organization-member-role.decorator'
import { OrganizationMemberRole } from '../enums/organization-member-role.enum'
import { SystemRole } from '../../user/enums/system-role.enum'
import { OrganizationAccessGuard } from './organization-access.guard'
import { OrganizationActionGuard } from './organization-action.guard'

@RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
class OwnerController {
  handler() {}

  @RequiredOrganizationMemberRole(OrganizationMemberRole.MEMBER)
  memberOverride() {}
}

@RequiredOrganizationMemberRole(OrganizationMemberRole.MEMBER)
class MemberController {
  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  ownerOverride() {}
}

class UnrestrictedController {
  handler() {}

  @RequiredOrganizationMemberRole(OrganizationMemberRole.OWNER)
  ownerOnly() {}
}

const cases = [
  [
    'class OWNER denies members',
    OwnerController,
    OwnerController.prototype.handler,
    OrganizationMemberRole.MEMBER,
    false,
  ],
  ['class OWNER allows owners', OwnerController, OwnerController.prototype.handler, OrganizationMemberRole.OWNER, true],
  [
    'method MEMBER overrides class OWNER',
    OwnerController,
    OwnerController.prototype.memberOverride,
    OrganizationMemberRole.MEMBER,
    true,
  ],
  [
    'method OWNER overrides class MEMBER',
    MemberController,
    MemberController.prototype.ownerOverride,
    OrganizationMemberRole.MEMBER,
    false,
  ],
  [
    'method-only OWNER denies members',
    UnrestrictedController,
    UnrestrictedController.prototype.ownerOnly,
    OrganizationMemberRole.MEMBER,
    false,
  ],
  [
    'missing metadata allows members',
    UnrestrictedController,
    UnrestrictedController.prototype.handler,
    OrganizationMemberRole.MEMBER,
    true,
  ],
] as const

describe('OrganizationActionGuard role metadata', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each(cases)('%s', async (_name, controller, handler, role, allowed) => {
    jest.spyOn(OrganizationAccessGuard.prototype, 'canActivate').mockResolvedValue(true)
    const guard = new OrganizationActionGuard({} as never, {} as never, new Reflector())
    const context = {
      getClass: () => controller,
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: SystemRole.USER, organizationUser: { role } } }) }),
    } as unknown as ExecutionContext

    await expect(guard.canActivate(context)).resolves.toBe(allowed)
  })
})
