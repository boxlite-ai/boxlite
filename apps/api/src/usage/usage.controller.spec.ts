/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { UsageController } from './usage.controller'
import { UsageMeteringService } from './usage-metering.service'

describe('UsageController', () => {
  const usageService = {
    getOrganizationMeteringView: jest.fn(),
  }
  let controller: UsageController

  beforeEach(() => {
    jest.resetAllMocks()
    controller = new UsageController(usageService as unknown as UsageMeteringService)
  })

  it('returns the organization metering view with parsed filters', async () => {
    usageService.getOrganizationMeteringView.mockResolvedValue({ organizationId: 'org-1' })

    await expect(
      controller.getOrganizationMetering('org-1', '2026-07-08T00:00:00Z', '2026-07-08T01:00:00Z', '25', 'box-1'),
    ).resolves.toEqual({ organizationId: 'org-1' })

    expect(usageService.getOrganizationMeteringView).toHaveBeenCalledWith('org-1', {
      from: new Date('2026-07-08T00:00:00Z'),
      to: new Date('2026-07-08T01:00:00Z'),
      limit: 25,
      boxId: 'box-1',
    })
  })

  it('rejects invalid date filters', async () => {
    expect(() => controller.getOrganizationMetering('org-1', 'not-a-date', undefined, undefined, undefined)).toThrow(
      BadRequestException,
    )
  })
})
