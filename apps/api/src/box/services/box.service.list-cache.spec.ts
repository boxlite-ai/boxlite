/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'

const ORG = '057963b2-60ca-4356-81fc-11503e15f249'

function createService(redis: any): BoxService {
  const service = Object.create(BoxService.prototype) as BoxService
  ;(service as any).redis = redis
  ;(service as any).logger = { warn: jest.fn() }
  return service
}

describe('BoxService.listBoxesCached', () => {
  it('serves a cache hit without touching the database', async () => {
    const dtos = [{ id: 'b1' }, { id: 'b2' }]
    const redis = {
      get: jest.fn().mockResolvedValue(JSON.stringify(dtos)),
      setex: jest.fn(),
    }
    const service = createService(redis)
    const findAll = jest.fn()
    ;(service as any).findAllDeprecated = findAll
    ;(service as any).toBoxDtos = jest.fn()

    const result = await service.listBoxesCached(ORG)

    expect(result).toEqual(dtos)
    expect(findAll).not.toHaveBeenCalled()
    expect(redis.setex).not.toHaveBeenCalled()
  })

  it('queries and populates the cache on a miss', async () => {
    const boxes = [{ id: 'b1' }]
    const dtos = [{ id: 'b1', dto: true }]
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    }
    const service = createService(redis)
    const findAll = jest.fn().mockResolvedValue(boxes)
    const toDtos = jest.fn().mockResolvedValue(dtos)
    ;(service as any).findAllDeprecated = findAll
    ;(service as any).toBoxDtos = toDtos

    const result = await service.listBoxesCached(ORG)

    expect(result).toBe(dtos)
    expect(findAll).toHaveBeenCalledTimes(1)
    expect(toDtos).toHaveBeenCalledWith(boxes)
    expect(redis.setex).toHaveBeenCalledTimes(1)
    expect(redis.setex.mock.calls[0][2]).toBe(JSON.stringify(dtos))
  })

  it('keys the cache distinctly by includeErroredDeleted and labels', async () => {
    const redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') }
    const service = createService(redis)
    ;(service as any).findAllDeprecated = jest.fn().mockResolvedValue([])
    ;(service as any).toBoxDtos = jest.fn().mockResolvedValue([])

    await service.listBoxesCached(ORG)
    await service.listBoxesCached(ORG, { tier: 'a' }, true)

    const k1 = redis.get.mock.calls[0][0]
    const k2 = redis.get.mock.calls[1][0]
    expect(k1).not.toEqual(k2)
  })
})
