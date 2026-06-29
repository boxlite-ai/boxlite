/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { UsageController } from './usage.controller'
import { BoxUsageResult, UsageService } from './usage.service'

function makeController() {
  const result: BoxUsageResult = {
    boxId: 'box-1',
    totalCPUSeconds: 0,
    totalRAMGBSeconds: 0,
    totalDiskGBSeconds: 0,
    totalGPUSeconds: 0,
  }
  const usageService = {
    getBoxUsage: jest.fn(async () => result),
  } as unknown as UsageService & { getBoxUsage: jest.Mock }
  return { controller: new UsageController(usageService), usageService }
}

describe('UsageController.getBoxUsage query validation', () => {
  it('rejects a malformed from date before calling the service', async () => {
    const { controller, usageService } = makeController()

    await expect(controller.getBoxUsage('box-1', { from: 'garbage' } as never)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(usageService.getBoxUsage).not.toHaveBeenCalled()
  })

  it('rejects an inverted date range before calling the service', async () => {
    const { controller, usageService } = makeController()

    await expect(
      controller.getBoxUsage('box-1', { from: '2026-06-28T00:00:00Z', to: '2026-06-27T00:00:00Z' } as never),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(usageService.getBoxUsage).not.toHaveBeenCalled()
  })
})
