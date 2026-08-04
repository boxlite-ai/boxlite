/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException } from '@nestjs/common'
import { BillingController } from './billing.controller'
import { BillingPeriodDto } from './dto/billing-period.dto'

const period: BillingPeriodDto = {
  periodId: 'period-1',
  boxId: 'box-1',
  organizationId: 'org-1',
  region: 'us',
  startAt: '2026-01-01T00:00:00.000Z',
  endAt: '2026-01-01T01:00:00.000Z',
  cpu: 1,
  gpu: 0,
  mem: 2,
  disk: 10,
}

function makeController() {
  const billingService = {
    listUnbilled: jest.fn().mockResolvedValue([period]),
    fetchArchived: jest.fn().mockResolvedValue(period),
    markBilled: jest.fn().mockResolvedValue(true),
    listOpenForOrganization: jest.fn().mockResolvedValue([period]),
  }
  return { controller: new BillingController(billingService as any), billingService }
}

describe('BillingController', () => {
  it('wraps listUnbilled in the { periods } envelope and forwards the limit', async () => {
    const { controller, billingService } = makeController()

    await expect(controller.listUnbilled(5)).resolves.toEqual({ periods: [period] })

    expect(billingService.listUnbilled).toHaveBeenCalledWith(5)
  })

  it('returns the period directly when fetchArchived finds one', async () => {
    const { controller } = makeController()

    await expect(controller.fetchArchived('period-1')).resolves.toEqual(period)
  })

  it('answers 404 rather than a bare null when no archived period matches', async () => {
    const { controller, billingService } = makeController()
    billingService.fetchArchived.mockResolvedValue(null)

    await expect(controller.fetchArchived('missing')).rejects.toBeInstanceOf(NotFoundException)
  })

  it("wraps markBilled's compare-and-swap result in { marked }", async () => {
    const { controller, billingService } = makeController()
    billingService.markBilled.mockResolvedValue(false)

    await expect(controller.markBilled('period-1')).resolves.toEqual({ marked: false })
    expect(billingService.markBilled).toHaveBeenCalledWith('period-1')
  })

  it('wraps listOpenForOrganization in the { periods } envelope', async () => {
    const { controller, billingService } = makeController()

    await expect(controller.listOpenForOrganization('org-1')).resolves.toEqual({ periods: [period] })
    expect(billingService.listOpenForOrganization).toHaveBeenCalledWith('org-1')
  })
})
