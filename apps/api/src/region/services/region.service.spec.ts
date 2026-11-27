/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { RegionService } from './region.service'

describe('RegionService query cache', () => {
  function makeService(enabled: boolean) {
    const regionRepository = { findOne: jest.fn().mockResolvedValue({ id: 'region-1' }) }
    const configService = { get: jest.fn((key: string) => (key === 'apiModuleCache.enabled' ? enabled : undefined)) }
    const service = new RegionService(regionRepository as any, {} as any, {} as any, {} as any, configService as any)
    return { service, regionRepository }
  }

  it('uses a 60-second query cache when the API module cache is enabled', async () => {
    const { service, regionRepository } = makeService(true)

    await service.findOne('region-1')

    expect(regionRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'region-1' },
      cache: { id: 'region:60s:region-1', milliseconds: 60_000 },
    })
  })

  it('preserves an explicit cache choice when the global switch is off', async () => {
    const { service, regionRepository } = makeService(false)

    await service.findOne('region-1', true)

    expect(regionRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'region-1' },
      cache: { id: 'region:30s:region-1', milliseconds: 30_000 },
    })
  })

  it('coalesces concurrent lookups within one cache policy', async () => {
    const { service, regionRepository } = makeService(true)
    let release!: (value: { id: string }) => void
    regionRepository.findOne.mockReturnValue(new Promise<{ id: string }>((resolve) => (release = resolve)))

    const first = service.findOne('region-1')
    const second = service.findOne('region-1')
    await Promise.resolve()
    release({ id: 'region-1' })

    const [left, right] = await Promise.all([first, second])
    expect(regionRepository.findOne).toHaveBeenCalledTimes(1)
    expect(left).toEqual(right)
    expect(left).not.toBe(right)
  })
})
