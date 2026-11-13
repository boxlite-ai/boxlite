import { ForbiddenException } from '@nestjs/common'
import { EnvironmentAccessCleanupService } from './environment-access-cleanup.service'
import { Context } from '../../common/context/context'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const member = (index: number, options: { personal?: boolean; own?: boolean; owner?: boolean } = {}) => ({
  userId: 'target',
  organizationId: id(index),
  isDefaultForUser: options.personal ?? false,
  role: options.personal || options.owner ? OrganizationMemberRole.OWNER : OrganizationMemberRole.MEMBER,
  organization: {
    id: id(index),
    name: `Organization ${index}`,
    createdBy: options.personal || options.own ? 'target' : 'other',
    suspended: false,
    suspendedUntil: null,
    suspendedAt: null as Date | null,
  },
})
function fixture(records = [member(1, { personal: true }), member(2), member(3, { own: true, owner: true })]) {
  const members = [...records]
  const repository = {
    find: jest.fn(async ({ where, take }) =>
      members
        .filter(
          (item) =>
            item.userId === where.userId && (!where.organizationId || item.organizationId > where.organizationId.value),
        )
        .sort((a, b) => a.organizationId.localeCompare(b.organizationId))
        .slice(0, take),
    ),
  }
  const memberships = {
    delete: jest.fn(async (organizationId: string) => {
      const index = members.findIndex((item) => item.organizationId === organizationId)
      members.splice(index, 1)
    }),
  }
  const organizations = {
    suspend: jest.fn(async (organizationId: string) => {
      const target = members.find((item) => item.organizationId === organizationId)!.organization
      target.suspended = true
      target.suspendedUntil = null
      target.suspendedAt = new Date()
    }),
  }
  const keys = { revokeUserKeys: jest.fn().mockResolvedValue({ deleted: 7, complete: true }) }
  const boxes = { findAll: jest.fn().mockResolvedValue({ items: [], totalPages: 0 }), stop: jest.fn() }
  const service = new EnvironmentAccessCleanupService(
    repository as never,
    memberships as never,
    organizations as never,
    keys as never,
    boxes as never,
  )
  return { service, members, repository, memberships, organizations, keys, boxes }
}
const actor = Context.admin({ userId: 'operator', authMethod: 'api_key' })

describe('environment access revocation cascade', () => {
  it('stops between members when the cleanup budget expires', async () => {
    const world = fixture([member(2), member(3)])
    let clock = 1000
    const now = jest.spyOn(Date, 'now').mockImplementation(() => clock)
    world.memberships.delete.mockImplementation(async () => {
      clock = 22000
    })
    try {
      const result = await world.service.revoke('target', actor)
      expect(result.complete).toBe(false)
      expect(result.errorCode).toBe('cleanup_timeout')
      expect(world.memberships.delete).toHaveBeenCalledTimes(1)
    } finally {
      now.mockRestore()
    }
  })
  it('removes a former creator who is now only a non-default member', async () => {
    const world = fixture([member(2, { own: true })])
    const result = await world.service.revoke('target', actor)
    expect(result.complete).toBe(true)
    expect(world.memberships.delete).toHaveBeenCalledWith(id(2), 'target')
    expect(world.organizations.suspend).not.toHaveBeenCalled()
  })
  it('leaves invited organizations, retains owned memberships and suspends only the personal default Owner organization', async () => {
    const world = fixture()
    const result = await world.service.revoke('target', actor)
    expect(result.complete).toBe(true)
    expect(world.memberships.delete).toHaveBeenCalledTimes(1)
    expect(world.memberships.delete).toHaveBeenCalledWith(id(2), 'target')
    expect(world.organizations.suspend).toHaveBeenCalledWith(id(1), 'Environment access revoked')
    expect(world.keys.revokeUserKeys).toHaveBeenCalledWith('target', expect.any(Number))
    expect(world.members.map((item) => item.organizationId)).toEqual([id(1), id(3)])
  })
  it('attempts every invited membership through more than two shrinking pages, including after a protected Owner failure', async () => {
    const world = fixture([member(1, { personal: true }), ...Array.from({ length: 301 }, (_, i) => member(i + 2))])
    const remove = world.memberships.delete.getMockImplementation()!
    world.memberships.delete.mockImplementation(async (organizationId) => {
      if (organizationId === id(102)) throw new ForbiddenException('At least one Owner is required')
      await remove(organizationId)
    })
    expect((await world.service.describe('target')).truncated).toBe(true)
    const result = await world.service.revoke('target', actor)
    expect(result.complete).toBe(false)
    expect(world.memberships.delete).toHaveBeenCalledTimes(301)
    expect(world.members.map((item) => item.organizationId)).toEqual([id(1), id(102)])
    expect(result.organizations.find((item) => item.organizationId === id(102))?.status).toBe('failed')
    expect(result.organizations.find((item) => item.organizationId === id(302))?.status).toBe('completed')
  })
  it('does not extend an active personal suspension on repeated revoke or restore removed memberships', async () => {
    const world = fixture()
    await world.service.revoke('target', actor)
    const suspendedAt = world.members[0].organization.suspendedAt
    world.organizations.suspend.mockClear()
    await world.service.revoke('target', actor)
    expect(world.organizations.suspend).not.toHaveBeenCalled()
    expect(world.members[0].organization.suspendedAt).toBe(suspendedAt)
    expect(world.members).toHaveLength(2)
  })

  it('replaces a temporary suspension with an indefinite access-revocation suspension', async () => {
    const world = fixture()
    Object.assign(world.members[0].organization, { suspended: true, suspendedUntil: new Date(Date.now() + 60_000) })
    await world.service.revoke('target', actor)
    expect(world.organizations.suspend).toHaveBeenCalledWith(id(1), 'Environment access revoked')
    expect(world.members[0].organization.suspendedUntil).toBeNull()
  })
  it('requests stops for all Box IDs captured before lifecycle changes shrink pages', async () => {
    const world = fixture()
    const live = Array.from({ length: 201 }, (_, i) => ({
      id: `box-${i}`,
      state: BoxState.STARTED,
      desiredState: BoxDesiredState.STARTED,
    }))
    world.boxes.findAll.mockImplementation(async (_org: string, page: number, limit: number) => ({
      items: live.slice((page - 1) * limit, page * limit),
      totalPages: Math.ceil(live.length / limit),
    }))
    world.boxes.stop.mockImplementation(async (boxId) => {
      live.splice(
        live.findIndex((box) => box.id === boxId),
        1,
      )
    })
    const result = await world.service.revoke('target', actor)
    expect(result.complete).toBe(true)
    expect(result.boxes).toHaveLength(201)
    expect(world.boxes.stop).toHaveBeenCalledTimes(201)
    expect(live).toHaveLength(0)
    expect(world.boxes.stop).toHaveBeenCalledWith('box-0', id(1), actor, false, 'id')
  })
  it('reports stop/scan failures, does not pause an invited shared organization and handles users without local state', async () => {
    const world = fixture([member(2)])
    world.repository.find.mockRejectedValueOnce(new Error('database unavailable'))
    expect((await world.service.revoke('target', actor)).complete).toBe(false)
    expect(world.organizations.suspend).not.toHaveBeenCalled()
    const empty = fixture([])
    empty.keys.revokeUserKeys.mockResolvedValue({ deleted: 0, complete: true })
    await expect(empty.service.revoke('new-auth0-user', actor)).resolves.toEqual({
      complete: true,
      apiKeys: { deleted: 0, complete: true },
      organizations: [],
      boxes: [],
    })
  })
})
