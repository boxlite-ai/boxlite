/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { GUARDS_METADATA } from '@nestjs/common/constants'
import { BoxAccessGuard } from '../../box/guards/box-access.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { UsageRangeQueryDto } from '../dto/usage-query.dto'
import { UsagePeriodDto } from '../dto/usage-response.dto'
import { UsageController } from './usage.controller'

describe('UsageController', () => {
  it('keeps deleted-box history accessible through organization authorization', async () => {
    const historicalPeriod: UsagePeriodDto = {
      cpu: 2,
      diskGB: 10,
      endAt: '2026-07-28T00:01:00.000Z',
      gpu: 0,
      price: 0,
      ramGB: 4,
      startAt: '2026-07-28T00:00:00.000Z',
    }
    const usageQueryService = {
      getBoxUsagePeriods: jest.fn().mockResolvedValue([historicalPeriod]),
    }
    const controller = new UsageController(usageQueryService as never)
    const query = Object.assign(new UsageRangeQueryDto(), {
      from: '2026-07-28T00:00:00.000Z',
      to: '2026-07-28T00:02:00.000Z',
    })

    const methodGuards = Reflect.getMetadata(GUARDS_METADATA, UsageController.prototype.getBoxUsagePeriods) ?? []
    const controllerGuards = Reflect.getMetadata(GUARDS_METADATA, UsageController) ?? []

    expect(methodGuards).not.toContain(BoxAccessGuard)
    expect(controllerGuards).toContain(OrganizationResourceActionGuard)
    await expect(controller.getBoxUsagePeriods('org-1', 'deleted-box-1', query)).resolves.toEqual([historicalPeriod])
    expect(usageQueryService.getBoxUsagePeriods).toHaveBeenCalledWith(
      'org-1',
      'deleted-box-1',
      new Date(query.from),
      new Date(query.to),
    )
  })
})
