/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }))
jest.mock('axios-debug-log', () => ({ __esModule: true, default: () => undefined }))
jest.mock('axios-retry', () => ({ __esModule: true, default: () => undefined }))

import axios from 'axios'
import { BoxliteBoxController } from './boxlite-box.controller'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { OrganizationBoxLimitsService } from '../organization/services/organization-box-limits.service'
import { Context } from '../common/context/context'

const get = axios.get as jest.Mock

describe('checkpoint Commerce plan sharing', () => {
  it('uses one organization-plan request across cold concurrency and per-box limit caches', async () => {
    get.mockImplementation(async (url: string) =>
      url.includes('/organization/')
        ? {
            data: {
              plan: {
                planId: 'pro',
                perBoxLimits: { maxCpuPerBox: 16, maxMemoryPerBox: 32, maxDiskPerBox: 100 },
              },
            },
          }
        : { data: [{ id: 'pro', concurrencyLimit: 8 }] },
    )
    const values = { billingApiUrl: 'https://commerce.test/api/billing/', 'usageExport.token': 'token' }
    const config = { get: (key: string) => values[key as keyof typeof values] }
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
    const commerce = new CommerceBoxLimitService(config as never, redis as never)
    const perBox = new OrganizationBoxLimitsService(config as never, redis as never)
    const checkpoint = {
      createBox: jest.fn().mockImplementation(async (organization) => ({
        id: 'box-1',
        state: 'started',
        limits: await perBox.resolve({
          id: organization.id,
          maxCpuPerBox: 4,
          maxMemoryPerBox: 8,
          maxDiskPerBox: 10,
        }),
      })),
    }
    const controller = new BoxliteBoxController(
      {} as never,
      { waitForStarted: jest.fn().mockImplementation(async (box) => box) } as never,
      commerce,
      checkpoint as never,
    )

    await controller.createBox(
      {
        organizationId: 'org-1',
        organization: { id: 'org-1' },
        userId: 'user-1',
      } as never,
      { checkpoint_id: 'checkpoint-1' } as never,
      Context.user(),
    )

    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls.filter(([url]) => String(url).includes('/organization/'))).toHaveLength(1)
    const created = await checkpoint.createBox.mock.results[0].value
    expect(created.limits).toEqual({
      maxCpuPerBox: 16,
      maxMemoryPerBox: 32,
      maxDiskPerBox: 100,
    })
  })
})
