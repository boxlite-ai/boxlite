/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'
import { BoxService } from './box.service'

// create() persists the box before it converts, so a rejection from the
// activity read reads to the client as a failed creation and invites a
// duplicate on retry. Last activity is metadata: it degrades, the box does not.
describe('BoxService DTO conversion', () => {
  const activityFailure = new Error('READONLY You cannot write against a read only replica')

  function createService(boxActivityService: unknown): BoxService {
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      logger: { warn: jest.fn(), error: jest.fn() },
      boxActivityService,
      resolveToolboxProxyUrl: jest.fn().mockResolvedValue('https://proxy.test/toolbox'),
      resolveToolboxProxyUrls: jest.fn(
        async (regionIds: string[]) => new Map(regionIds.map((id) => [id, `https://${id}.test/toolbox`])),
      ),
    })
    return service
  }

  it('serves a box without its last activity when the activity read fails', async () => {
    const box = new Box('us', 'data-loader')
    const service = createService({ getLastActivityAt: jest.fn().mockRejectedValue(activityFailure) })

    const dto = await service.toBoxDto(box)

    expect(dto.id).toBe(box.id)
    expect(dto.toolboxProxyUrl).toBe('https://proxy.test/toolbox')
    expect(dto.lastActivityAt).toBeUndefined()
  })

  it('serves a box list without last activity when the bulk activity read fails', async () => {
    const boxes = [new Box('us', 'data-loader'), new Box('eu', 'log-shipper')]
    const service = createService({ getLastActivityAtMany: jest.fn().mockRejectedValue(activityFailure) })

    const dtos = await service.toBoxDtos(boxes)

    expect(dtos.map((dto) => dto.id)).toEqual(boxes.map((box) => box.id))
    expect(dtos.map((dto) => dto.toolboxProxyUrl)).toEqual(['https://us.test/toolbox', 'https://eu.test/toolbox'])
    expect(dtos.map((dto) => dto.lastActivityAt)).toEqual([undefined, undefined])
  })

  it('still fails the conversion when the toolbox proxy URL cannot be resolved', async () => {
    const box = new Box('us', 'data-loader')
    const service = createService({ getLastActivityAt: jest.fn().mockResolvedValue(null) })
    ;(service as any).resolveToolboxProxyUrl = jest.fn().mockRejectedValue(new Error('region lookup failed'))

    await expect(service.toBoxDto(box)).rejects.toThrow('region lookup failed')
  })
})
