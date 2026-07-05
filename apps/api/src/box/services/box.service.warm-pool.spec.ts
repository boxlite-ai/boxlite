/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DEFAULT_AUTO_STOP_INTERVAL_MINUTES } from '../constants/box.constants'
import { Box } from '../entities/box.entity'
import { BoxService } from './box.service'

function createHarness() {
  const boxRepository = {
    update: jest.fn(async (_id: string, { updateData, entity }: { updateData: Partial<Box>; entity: Box }) => ({
      ...entity,
      ...updateData,
    })),
  }
  const service = Object.create(BoxService.prototype) as BoxService
  ;(service as any).boxRepository = boxRepository
  ;(service as any).boxLookupCacheInvalidationService = {
    invalidateOrgId: jest.fn(),
  }
  ;(service as any).eventEmitter = {
    emit: jest.fn(),
  }
  ;(service as any).toBoxDto = jest.fn().mockResolvedValue({ id: 'warm-box' })

  return { service, boxRepository }
}

describe('BoxService warm pool assignment', () => {
  it('resets auto-stop to the public default when assigning a pre-warmed box', async () => {
    const { service, boxRepository } = createHarness()
    const warmPoolBox = new Box('us', 'warm-box')
    warmPoolBox.runnerId = 'runner-1'
    warmPoolBox.autoStopInterval = 15

    await (service as any).assignWarmPoolBox(warmPoolBox, {}, { id: 'org-1', boxLimitedNetworkEgress: false })

    expect(boxRepository.update).toHaveBeenCalledWith(
      warmPoolBox.id,
      expect.objectContaining({
        updateData: expect.objectContaining({
          autoStopInterval: DEFAULT_AUTO_STOP_INTERVAL_MINUTES,
        }),
      }),
    )
  })

  it('keeps an explicit auto-stop override when assigning a pre-warmed box', async () => {
    const { service, boxRepository } = createHarness()
    const warmPoolBox = new Box('us', 'warm-box')
    warmPoolBox.runnerId = 'runner-1'

    await (service as any).assignWarmPoolBox(
      warmPoolBox,
      { autoStopInterval: 0 },
      { id: 'org-1', boxLimitedNetworkEgress: false },
    )

    expect(boxRepository.update).toHaveBeenCalledWith(
      warmPoolBox.id,
      expect.objectContaining({
        updateData: expect.objectContaining({
          autoStopInterval: 0,
        }),
      }),
    )
  })
})
