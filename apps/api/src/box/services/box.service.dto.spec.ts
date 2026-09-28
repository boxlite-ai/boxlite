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

  const exitCodeReader = (code?: number) => ({ getExitCode: jest.fn().mockResolvedValue(code) })

  function createService(boxActivityService: unknown, boxExitCodeService: unknown = exitCodeReader()): BoxService {
    const service = Object.create(BoxService.prototype) as BoxService
    Object.assign(service as any, {
      logger: { warn: jest.fn(), error: jest.fn() },
      boxActivityService,
      boxExitCodeService,
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

  // toBoxDto is on the event path: NotificationService converts through it for
  // every BoxEvents.STATE_UPDATED, and BoxStateWaiterService for every
  // resolution. A box reaching STOPPED fires both, so a runner call here would
  // put a cross-service round trip in front of every stop notification and
  // stall it for the timeout exactly when the runner is what failed. The code
  // belongs on the tenant's read, and nowhere else.
  it('does not ask the runner for an exit code on the event path', async () => {
    const box = new Box('us', 'data-loader')
    const reader = exitCodeReader(137)
    const service = createService({ getLastActivityAt: jest.fn().mockResolvedValue(null) }, reader)

    const dto = await service.toBoxDto(box)

    expect(reader.getExitCode).not.toHaveBeenCalled()
    expect(dto.exitCode).toBeUndefined()
  })

  it('asks the runner when a tenant reads the box', async () => {
    const box = new Box('us', 'data-loader')
    const reader = exitCodeReader(137)
    const service = createService({ getLastActivityAt: jest.fn().mockResolvedValue(null) }, reader)

    const dto = await service.toBoxDtoWithExitCode(box)

    expect(reader.getExitCode).toHaveBeenCalledWith(box)
    expect(dto.exitCode).toBe(137)
  })

  // 0 is a value; absence has to survive serialization as a missing field,
  // which is the contract the REST mapper and the generated clients read.
  it.each([
    ['a main command that succeeded', 0, 0],
    ['a box that recorded none', undefined, undefined],
  ])('reads %s', async (_case, read, expected) => {
    const box = new Box('us', 'data-loader')
    const service = createService({ getLastActivityAt: jest.fn().mockResolvedValue(null) }, exitCodeReader(read))

    const dto = await service.toBoxDtoWithExitCode(box)

    expect(dto.exitCode).toBe(expected)
    if (expected === undefined) {
      expect(JSON.parse(JSON.stringify(dto))).not.toHaveProperty('exitCode')
    }
  })
})
