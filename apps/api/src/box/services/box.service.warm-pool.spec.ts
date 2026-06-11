/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'
import { BoxClass } from '../enums/box-class.enum'
import { WarmPool } from '../entities/warm-pool.entity'
import { BOX_IMAGE_REF_LABEL } from '../constants/curated-images.constant'

function warmPoolItem(): WarmPool {
  const item = new WarmPool()
  item.target = 'us'
  item.class = BoxClass.SMALL
  item.cpu = 1
  item.gpu = 0
  item.mem = 1
  item.disk = 3
  item.env = {}
  return item
}

describe('BoxService.createForWarmPool image ref', () => {
  it('stashes the default curated image ref so warm-pool boxes can boot', async () => {
    const insert = jest.fn().mockResolvedValue(undefined)
    const getRandomAvailableRunner = jest.fn().mockResolvedValue({ id: 'runner-1' })

    const service = Object.create(BoxService.prototype) as BoxService
    ;(service as any).boxRepository = { insert }
    ;(service as any).runnerService = { getRandomAvailableRunner }

    const box = await service.createForWarmPool(warmPoolItem())

    // Without this label, box-start drives the box to ERROR ("missing image ref") and the
    // warm-pool refill loop recreates it forever. It must point at the base curated image.
    expect(box.labels[BOX_IMAGE_REF_LABEL]).toBeDefined()
    expect(box.labels[BOX_IMAGE_REF_LABEL]).toContain('boxlite-agent-base')
    expect(insert).toHaveBeenCalledWith(box)
  })
})
