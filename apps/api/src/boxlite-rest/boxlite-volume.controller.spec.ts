import { BoxliteVolumeController } from './boxlite-volume.controller'
import { VolumeService } from '../box/services/volume.service'
import { NotFoundException } from '@nestjs/common'
import { VolumeState } from '../box/enums/volume-state.enum'

describe('BoxliteVolumeController', () => {
  const createdAt = new Date('2026-07-27T00:00:00.000Z')
  const updatedAt = new Date('2026-07-28T00:00:00.000Z')
  const lastUsedAt = new Date('2026-07-29T00:00:00.000Z')
  const volume = {
    id: 'volume-1',
    name: 'workspace',
    state: VolumeState.READY,
    createdAt,
    updatedAt,
    lastUsedAt,
    errorReason: undefined,
  }

  function createController() {
    const volumeService = {
      create: jest.fn().mockResolvedValue(volume),
      waitForReady: jest.fn().mockResolvedValue(volume),
      findAll: jest.fn().mockResolvedValue([volume]),
      findOne: jest.fn().mockResolvedValue(volume),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    return {
      controller: new BoxliteVolumeController(volumeService as unknown as VolumeService),
      volumeService,
    }
  }

  it('creates an unbounded S3 volume', async () => {
    const { controller, volumeService } = createController()
    const organization = { id: 'org-1' }

    await expect(
      controller.create({
        organization,
        organizationId: organization.id,
      } as never),
    ).resolves.toEqual({
      id: volume.id,
      name: volume.name,
      state: volume.state,
      created_at: createdAt.toISOString(),
      updated_at: updatedAt.toISOString(),
      last_used_at: lastUsedAt.toISOString(),
      error_reason: undefined,
    })
    expect(volumeService.create).toHaveBeenCalledWith(organization, {})
    expect(volumeService.waitForReady).toHaveBeenCalledWith(volume.id, 30)
  })

  // A name is what makes `-v my-data:/data` work, so it has to survive the
  // controller rather than being dropped the way the empty `{}` body used to.
  it('forwards a requested volume name to the service', async () => {
    const { controller, volumeService } = createController()
    const organization = { id: 'org-1' }

    await controller.create({ organization, organizationId: organization.id } as never, {
      name: 'my-data',
    })

    expect(volumeService.create).toHaveBeenCalledWith(organization, { name: 'my-data' })
  })

  // The body is optional in the spec, so an absent one must still create an
  // unnamed volume instead of throwing on a missing property.
  it('creates an unnamed volume when no body is sent', async () => {
    const { controller, volumeService } = createController()
    const organization = { id: 'org-1' }

    await controller.create({ organization, organizationId: organization.id } as never, undefined)

    expect(volumeService.create).toHaveBeenCalledWith(organization, {})
  })

  it('lists volumes for the authenticated organization', async () => {
    const { controller, volumeService } = createController()

    await expect(controller.list({ organizationId: 'org-1' } as never)).resolves.toEqual({
      volumes: [
        {
          id: volume.id,
          name: volume.name,
          state: volume.state,
          created_at: createdAt.toISOString(),
        },
      ],
    })
    expect(volumeService.findAll).toHaveBeenCalledWith('org-1')
  })

  it('gets a volume by ID', async () => {
    const { controller, volumeService } = createController()

    await expect(controller.get(volume.id)).resolves.toEqual({
      id: volume.id,
      name: volume.name,
      state: volume.state,
      created_at: createdAt.toISOString(),
      updated_at: updatedAt.toISOString(),
      last_used_at: lastUsedAt.toISOString(),
      error_reason: undefined,
    })
    expect(volumeService.findOne).toHaveBeenCalledWith(volume.id)
  })

  it('deletes a volume by ID', async () => {
    const { controller, volumeService } = createController()

    await expect(controller.remove(volume.id)).resolves.toBeUndefined()
    expect(volumeService.delete).toHaveBeenCalledWith(volume.id, false)
  })

  it('propagates a missing-volume error without force', async () => {
    const { controller, volumeService } = createController()
    const error = new NotFoundException('Volume not found')
    volumeService.delete.mockRejectedValueOnce(error)

    await expect(controller.remove(volume.id)).rejects.toBe(error)
  })

  it('passes force deletion semantics to the volume service', async () => {
    const { controller, volumeService } = createController()

    await expect(controller.remove(volume.id, 'true')).resolves.toBeUndefined()
    expect(volumeService.delete).toHaveBeenCalledWith(volume.id, true)
  })

  it('propagates non-not-found errors when force is true', async () => {
    const { controller, volumeService } = createController()
    const error = new Error('S3 unavailable')
    volumeService.delete.mockRejectedValueOnce(error)

    await expect(controller.remove(volume.id, 'true')).rejects.toBe(error)
  })
})
