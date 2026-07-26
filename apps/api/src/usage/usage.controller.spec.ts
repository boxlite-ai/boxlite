/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { UsageController } from './usage.controller'
import { BoxUsageResult, UsageService } from './usage.service'

const RESULT: BoxUsageResult = {
  boxId: 'box-1',
  totalCPUSeconds: 0,
  totalRAMGBSeconds: 0,
  totalDiskGBSeconds: 0,
  totalGPUSeconds: 0,
}

describe('UsageController.getBoxUsage query-range validation', () => {
  let getBoxUsage: jest.Mock
  let ctrl: UsageController

  beforeEach(() => {
    getBoxUsage = jest.fn(async () => RESULT)
    ctrl = new UsageController({ getBoxUsage } as unknown as UsageService)
  })

  it('rejects an unparsable from/to with 400 instead of passing Invalid Date downstream', async () => {
    await expect(ctrl.getBoxUsage('box-1', 'not-a-date', undefined)).rejects.toBeInstanceOf(BadRequestException)
    await expect(ctrl.getBoxUsage('box-1', undefined, 'also-bad')).rejects.toBeInstanceOf(BadRequestException)
    expect(getBoxUsage).not.toHaveBeenCalled()
  })

  it('rejects an inverted range (from after to)', async () => {
    await expect(
      ctrl.getBoxUsage('box-1', '2026-06-25T12:00:00Z', '2026-06-25T11:00:00Z'),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(getBoxUsage).not.toHaveBeenCalled()
  })

  it('passes parsed dates through for a valid range', async () => {
    await expect(ctrl.getBoxUsage('box-1', '2026-06-25T11:00:00Z', '2026-06-25T12:00:00Z')).resolves.toEqual(RESULT)
    expect(getBoxUsage).toHaveBeenCalledWith(
      'box-1',
      new Date('2026-06-25T11:00:00Z'),
      new Date('2026-06-25T12:00:00Z'),
    )
  })
})
