/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NotFoundException } from '@nestjs/common'
import { AdminOrganizationController } from './organization.controller'
import { DEFAULT_ORG_QUOTA } from '../../organization/services/org-quota'

const ORG_ID = '11111111-1111-1111-1111-111111111111'

function makeController(overrides: { organizationExists?: boolean; customized?: boolean } = {}) {
  const { organizationExists = true, customized = false } = overrides

  const organizationService = {
    findOne: jest.fn().mockResolvedValue(organizationExists ? { id: ORG_ID } : null),
  }
  const organizationUsageService = {
    getQuotaLimits: jest.fn().mockResolvedValue(DEFAULT_ORG_QUOTA),
    hasCustomQuota: jest.fn().mockResolvedValue(customized),
    updateQuotaLimits: jest
      .fn()
      .mockImplementation(async (_id: string, patch: Record<string, number>) => ({ ...DEFAULT_ORG_QUOTA, ...patch })),
  }

  const controller = new AdminOrganizationController(organizationService as never, organizationUsageService as never)

  return { controller, organizationService, organizationUsageService }
}

describe('AdminOrganizationController quota', () => {
  describe('getQuota', () => {
    it('reports the built-in defaults as not customized when the org has no row', async () => {
      const { controller } = makeController({ customized: false })

      const quota = await controller.getQuota(ORG_ID)

      expect(quota).toEqual({ ...DEFAULT_ORG_QUOTA, customized: false })
    })

    it('flags an organization that has its own quota row', async () => {
      const { controller } = makeController({ customized: true })

      expect((await controller.getQuota(ORG_ID)).customized).toBe(true)
    })

    it('404s for an unknown organization rather than reporting defaults', async () => {
      const { controller, organizationUsageService } = makeController({ organizationExists: false })

      await expect(controller.getQuota(ORG_ID)).rejects.toThrow(NotFoundException)
      expect(organizationUsageService.getQuotaLimits).not.toHaveBeenCalled()
    })
  })

  describe('updateQuota', () => {
    it('applies a partial patch and leaves the other ceilings alone', async () => {
      const { controller } = makeController()

      const quota = await controller.updateQuota(ORG_ID, { totalCpuQuota: 128 })

      expect(quota.totalCpuQuota).toBe(128)
      expect(quota.totalMemoryQuota).toBe(DEFAULT_ORG_QUOTA.totalMemoryQuota)
      expect(quota.maxConcurrentBoxes).toBe(DEFAULT_ORG_QUOTA.maxConcurrentBoxes)
      expect(quota.customized).toBe(true)
    })

    // 0 is falsy: the controller must forward it to the service and back out through
    // the response untouched, rather than dropping it as "nothing to change".
    it('can set a ceiling to zero', async () => {
      const { controller, organizationUsageService } = makeController()

      const quota = await controller.updateQuota(ORG_ID, { maxConcurrentBoxes: 0 })

      expect(organizationUsageService.updateQuotaLimits).toHaveBeenCalledWith(ORG_ID, { maxConcurrentBoxes: 0 })
      expect(quota.maxConcurrentBoxes).toBe(0)
    })

    it('404s for an unknown organization rather than writing an orphan quota row', async () => {
      const { controller, organizationUsageService } = makeController({ organizationExists: false })

      await expect(controller.updateQuota(ORG_ID, { totalCpuQuota: 1 })).rejects.toThrow(NotFoundException)
      expect(organizationUsageService.updateQuotaLimits).not.toHaveBeenCalled()
    })
  })
})
