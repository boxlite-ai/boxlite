import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { PreviewController } from './preview.controller'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { ProxyGuard } from '../guards/proxy.guard'
import { BoxState } from '../enums/box-state.enum'

describe('PreviewController private tunnel credential scope', () => {
  function fixture(membership: object | null = { role: 'owner', assignedRoles: [] }) {
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn() }
    const memberships = {
      exists: jest.fn().mockResolvedValue(membership !== null),
      findOne: jest.fn().mockResolvedValue(membership),
    }
    const controller = new PreviewController(
      redis as never,
      { findOne: jest.fn().mockResolvedValue({ organizationId: 'box-org' }) } as never,
      memberships as never,
      null as never,
      { findOne: jest.fn().mockResolvedValue({ id: 'box-org' }) } as never,
      null as never,
      null as never,
    )
    return controller
  }

  it('rejects an API key for another organization even when its owner belongs to both', async () => {
    const request = {
      user: {
        userId: 'user-1',
        role: 'user',
        organizationId: 'other-org',
        apiKey: { organizationId: 'other-org', permissions: ['write:boxes'] },
      },
    }
    await expect(fixture().hasBoxAccess(request as never, 'box-1')).rejects.toBeInstanceOf(NotFoundException)
  })

  // Reaching a tunnel needs membership only; creating one needs write:boxes.
  it('accepts a same-organization API key or read-only member without write:boxes', async () => {
    const readOnly = { role: 'member', assignedRoles: [] }
    const apiKey = {
      user: {
        userId: 'user-1',
        role: 'user',
        organizationId: 'box-org',
        apiKey: { organizationId: 'box-org', permissions: [] },
      },
    }
    const jwt = { user: { userId: 'user-1', role: 'user' } }
    await expect(fixture(readOnly).hasBoxAccess(apiKey as never, 'box-1')).resolves.toBe(true)
    await expect(fixture(readOnly).hasBoxAccess(jwt as never, 'box-1')).resolves.toBe(true)
  })

  it('rejects a user who is no longer a member', async () => {
    const jwt = { user: { userId: 'user-1', role: 'user' } }
    await expect(fixture(null).hasBoxAccess(jwt as never, 'box-1')).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('PreviewController public tunnel check', () => {
  const access = jest.fn()
  const controller = new PreviewController(
    null as never,
    null as never,
    null as never,
    { isPublicAccessAllowed: access } as never,
    null as never,
    null as never,
    null as never,
  )

  beforeEach(() => access.mockReset())

  it('keeps the proxy-only endpoint out of generated API clients', () => {
    expect(Reflect.getMetadata('swagger/apiExcludeEndpoint', controller.isPublicTunnelActive)).toEqual({
      disable: true,
    })
  })

  it('accepts only an active public tunnel', async () => {
    access.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(controller.isPublicTunnelActive('box-1', 3000)).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.isPublicTunnelActive('box-1', 3000)).resolves.toBe(true)
    expect(access).toHaveBeenCalledWith('box-1', 3000)
  })
})

describe('PreviewController browser tunnel sessions', () => {
  it('rechecks current membership before accepting a signed user session', async () => {
    const memberships = { exists: jest.fn().mockResolvedValue(true) }
    const users = { findOne: jest.fn().mockResolvedValue({ id: 'user-1', role: 'user' }) }
    const tunnels = { access: jest.fn().mockResolvedValue({ id: 'tunnel-1', authGeneration: 1 }) }
    const controller = new PreviewController(
      null as never,
      { findOne: jest.fn().mockResolvedValue({ organizationId: 'org-1' }) } as never,
      memberships as never,
      tunnels as never,
      null as never,
      null as never,
      users as never,
    )
    await expect(controller.tunnelAccess('box-1', 3000, { userId: 'user-1' })).resolves.toMatchObject({
      id: 'tunnel-1',
    })
    memberships.exists.mockResolvedValue(false)
    await expect(controller.tunnelAccess('box-1', 3000, { userId: 'user-1' })).rejects.toBeInstanceOf(NotFoundException)
    expect(tunnels.access).toHaveBeenCalledTimes(1)
    expect(users.findOne).toHaveBeenCalledTimes(2)
  })
})

describe('PreviewController ensure-ready', () => {
  const box = { id: 'box-1', organizationId: 'org-1', autoResume: true, state: BoxState.STOPPED }
  const organization = { id: 'org-1', suspended: false }
  let calls: string[]
  let boxService: { findOne: jest.Mock; updateLastActivityAt: jest.Mock }
  let organizationService: { findOne: jest.Mock }
  let autoResume: { ensureReady: jest.Mock }
  let controller: PreviewController

  beforeEach(() => {
    calls = []
    boxService = {
      findOne: jest.fn().mockResolvedValue(box),
      updateLastActivityAt: jest.fn(async () => {
        calls.push('activity')
      }),
    }
    organizationService = { findOne: jest.fn().mockResolvedValue(organization) }
    autoResume = {
      ensureReady: jest.fn(async () => {
        calls.push('ensureReady')
      }),
    }
    controller = new PreviewController(
      null as never,
      boxService as never,
      null as never,
      null as never,
      organizationService as never,
      autoResume as never,
      null as never,
    )
  })

  it('is proxy-only and kept out of generated API clients', () => {
    expect(Reflect.getMetadata('swagger/apiExcludeEndpoint', controller.ensureReady)).toEqual({ disable: true })
    expect(Reflect.getMetadata('__guards__', controller.ensureReady)).toEqual([CombinedAuthGuard, ProxyGuard])
  })

  it('records activity, then wakes the box with the organization that owns it', async () => {
    await controller.ensureReady('box-1')

    expect(calls).toEqual(['activity', 'ensureReady'])
    expect(organizationService.findOne).toHaveBeenCalledWith('org-1')
    expect(autoResume.ensureReady).toHaveBeenCalledWith('box-1', organization)
  })

  it('refuses to wake a box that disabled auto-resume, without recording activity', async () => {
    boxService.findOne.mockResolvedValue({ ...box, autoResume: false })

    await expect(controller.ensureReady('box-1')).rejects.toBeInstanceOf(ConflictException)
    expect(calls).toEqual([])
  })

  it('lets the proxy keep polling a started box, such as one paused for a snapshot, even with auto-resume off', async () => {
    boxService.findOne.mockResolvedValue({
      ...box,
      state: BoxState.STARTED,
      desiredState: 'started',
      autoResume: false,
    })

    await expect(controller.ensureReady('box-1')).resolves.toBeUndefined()
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
  })

  it.each(['stopped', 'destroyed'])(
    'refuses a box with auto-resume off whose desired state is %s, not a paused one',
    async (desiredState) => {
      boxService.findOne.mockResolvedValue({ ...box, state: BoxState.STARTED, desiredState, autoResume: false })

      await expect(controller.ensureReady('box-1')).rejects.toBeInstanceOf(ConflictException)
    },
  )

  it('still hands an auto-resume box caught mid-stop to auto-resume, which restarts it', async () => {
    boxService.findOne.mockResolvedValue({ ...box, state: BoxState.STARTED, desiredState: 'stopped' })

    await controller.ensureReady('box-1')

    expect(autoResume.ensureReady).toHaveBeenCalledWith('box-1', organization)
  })

  it.each([BoxState.ARCHIVED, BoxState.ARCHIVING, BoxState.RESIZING, BoxState.ERROR])(
    'refuses a box in the %s state at once instead of waiting for a start that never comes',
    async (state) => {
      boxService.findOne.mockResolvedValue({ ...box, state })

      await expect(controller.ensureReady('box-1')).rejects.toBeInstanceOf(BadRequestException)
      expect(calls).toEqual([])
    },
  )

  it('treats a box whose organization is gone as not found', async () => {
    organizationService.findOne.mockResolvedValue(null)

    await expect(controller.ensureReady('box-1')).rejects.toBeInstanceOf(NotFoundException)
    expect(autoResume.ensureReady).not.toHaveBeenCalled()
  })
})
