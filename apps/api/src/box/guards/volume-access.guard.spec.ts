import { ExecutionContext, NotFoundException } from '@nestjs/common'
import { EntityNotFoundError } from 'typeorm'
import { VolumeAccessGuard } from './volume-access.guard'
import { VolumeService } from '../services/volume.service'
import { randomUUID } from 'node:crypto'
import { Request } from 'express'
import { BoxRequestReplayService, ReplayResponse } from '../../boxlite-rest/box-request-replay.service'
import { replayIdentity, REPLAY_ONLY, REPLAY_RESOURCE } from '../../boxlite-rest/request-replay-policy'

describe('VolumeAccessGuard', () => {
  const volumeId = 'volume-1'

  function createGuard(options?: {
    method?: string
    force?: string
    organizationId?: string
    volumeOrganizationId?: string
    error?: Error
  }) {
    const request = {
      method: options?.method ?? 'GET',
      params: { volumeId },
      query: options?.force === undefined ? {} : { force: options.force },
      user: {
        organizationId: options?.organizationId ?? 'org-1',
      },
    }
    const getOrganizationId = options?.error
      ? jest.fn().mockRejectedValue(options.error)
      : jest.fn().mockResolvedValue(options?.volumeOrganizationId ?? 'org-1')
    const guard = new VolumeAccessGuard({ getOrganizationId } as unknown as VolumeService)
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as ExecutionContext

    return { guard, context, getOrganizationId }
  }

  it('allows force deletion when the volume is already absent', async () => {
    const { guard, context } = createGuard({
      method: 'DELETE',
      force: 'true',
      error: new EntityNotFoundError('Volume', { id: volumeId }),
    })

    await expect(guard.canActivate(context)).resolves.toBe(true)
  })

  it('rejects a missing volume without force', async () => {
    const { guard, context } = createGuard({
      method: 'DELETE',
      error: new EntityNotFoundError('Volume', { id: volumeId }),
    })

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('does not allow force to bypass organization ownership', async () => {
    const { guard, context } = createGuard({
      method: 'DELETE',
      force: 'true',
      organizationId: 'org-1',
      volumeOrganizationId: 'org-2',
    })

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('does not allow force on non-delete requests', async () => {
    const { guard, context } = createGuard({
      method: 'GET',
      force: 'true',
      error: new EntityNotFoundError('Volume', { id: volumeId }),
    })

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('does not allow force to bypass volume lookup failures', async () => {
    const { guard, context } = createGuard({
      method: 'DELETE',
      force: 'true',
      error: new Error('database unavailable'),
    })

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException)
  })

  function replayGuard(completed?: ReplayResponse, error: Error = new EntityNotFoundError('Volume', { id: volumeId })) {
    const key = randomUUID()
    const request = {
      method: 'DELETE',
      originalUrl: `/api/v1/volumes/${volumeId}`,
      path: `/api/v1/volumes/${volumeId}`,
      route: { path: '/api/v1/volumes/:volumeId' },
      params: { volumeId },
      query: {},
      headers: { 'idempotency-key': key },
      rawHeaders: ['Idempotency-Key', key],
      user: { organizationId: 'org-1', userId: 'user-1' },
    }
    const peekCompleted = jest.fn().mockResolvedValue(completed)
    const getOrganizationId = jest.fn().mockRejectedValue(error)
    const guard = new VolumeAccessGuard(
      { getOrganizationId } as unknown as VolumeService,
      { peekCompleted } as unknown as BoxRequestReplayService,
    )
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext
    return { guard, context, request, peekCompleted, getOrganizationId, key }
  }

  it('uses completed trusted ownership only for the exact current request', async () => {
    const completed = { status: 204, body: '', resource: { id: volumeId, organizationId: 'org-1' } }
    const { guard, context, request, peekCompleted, key } = replayGuard(completed)
    const identity = replayIdentity(request as unknown as Request)
    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(peekCompleted).toHaveBeenCalledWith('org-1', 'user-1', identity.operation, key, identity.fingerprint)
    expect(Reflect.get(request, REPLAY_ONLY)).toBe(true)
    expect(Reflect.get(request, REPLAY_RESOURCE)).toEqual(completed.resource)
  })

  it.each([
    undefined,
    { status: 204, body: '' },
    { status: 204, body: '', resource: { id: 'another-volume', organizationId: 'org-1' } },
    { status: 204, body: '', resource: { id: volumeId, organizationId: 'another-org' } },
  ])('denies absent or mismatched trusted ownership: %p', async (completed) => {
    const { guard, context, request } = replayGuard(completed)
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException)
    expect(Reflect.get(request, REPLAY_ONLY)).toBeUndefined()
  })

  it('does not consult replay storage for database failures', async () => {
    const { guard, context, peekCompleted } = replayGuard(
      { status: 204, body: '', resource: { id: volumeId, organizationId: 'org-1' } },
      new Error('database unavailable'),
    )
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException)
    expect(peekCompleted).not.toHaveBeenCalled()
  })

  it('records ownership only after the current resource belongs to the organization', async () => {
    const { guard, context, request, getOrganizationId, peekCompleted } = replayGuard()
    getOrganizationId.mockResolvedValueOnce('org-1')
    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(Reflect.get(request, REPLAY_RESOURCE)).toEqual({ id: volumeId, organizationId: 'org-1' })
    expect(peekCompleted).not.toHaveBeenCalled()
  })

  it('never replaces a cross-organization denial with completed evidence', async () => {
    const { guard, context, request, getOrganizationId, peekCompleted } = replayGuard({
      status: 204,
      body: '',
      resource: { id: volumeId, organizationId: 'org-1' },
    })
    getOrganizationId.mockResolvedValueOnce('another-org')
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(NotFoundException)
    expect(Reflect.get(request, REPLAY_RESOURCE)).toBeUndefined()
    expect(peekCompleted).not.toHaveBeenCalled()
  })
})
