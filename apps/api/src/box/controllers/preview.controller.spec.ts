import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { PreviewController } from './preview.controller'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { ProxyGuard } from '../guards/proxy.guard'
import { BoxState } from '../enums/box-state.enum'

describe('PreviewController public tunnel check', () => {
  const access = jest.fn()
  const controller = new PreviewController(
    null as never,
    null as never,
    null as never,
    { isPublicAccessAllowed: access } as never,
    null as never,
    null as never,
  )

  beforeEach(() => access.mockReset())

  it('keeps the proxy-only endpoint out of generated API clients', () => {
    expect(Reflect.getMetadata('swagger/apiExcludeEndpoint', controller.isPublicTunnelActive)).toEqual({ disable: true })
  })

  it('accepts only an active public tunnel', async () => {
    access.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(controller.isPublicTunnelActive('box-1', 3000)).rejects.toBeInstanceOf(NotFoundException)
    await expect(controller.isPublicTunnelActive('box-1', 3000)).resolves.toBe(true)
    expect(access).toHaveBeenCalledWith('box-1', 3000)
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
    boxService.findOne.mockResolvedValue({ ...box, state: BoxState.STARTED, desiredState: 'started', autoResume: false })

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
