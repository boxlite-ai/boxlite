import { ExecutionContext, NotFoundException } from '@nestjs/common'
import { EntityNotFoundError } from 'typeorm'
import { VolumeAccessGuard } from './volume-access.guard'
import { VolumeService } from '../services/volume.service'

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
})
