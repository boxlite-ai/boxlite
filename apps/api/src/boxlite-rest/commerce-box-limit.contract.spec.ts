/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}))

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import axios from 'axios'
import { CommerceBoxLimitService } from './commerce-box-limit.service'

const commerceRepository = process.env.BOXLITE_COMMERCE_REPOSITORY
const describeWithCommerce = commerceRepository ? describe : describe.skip
const get = axios.get as jest.Mock

describeWithCommerce('Commerce box limit cross-repository contract', () => {
  it('consumes the no-subscription and ordered catalog responses produced by Commerce', async () => {
    if (!commerceRepository) {
      throw new Error('BOXLITE_COMMERCE_REPOSITORY is required for the cross-repository contract test')
    }

    const providerResponses = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-r',
          resolve(commerceRepository, 'node_modules/ts-node/register/transpile-only.js'),
          resolve(__dirname, '../../scripts/probe-commerce-box-limit-contract.cjs'),
        ],
        { cwd: commerceRepository, encoding: 'utf8' },
      ),
    ) as { catalog: unknown; noSubscription: unknown }
    const catalogResponse = providerResponses.catalog
    const organizationPlanResponse = providerResponses.noSubscription
    get.mockResolvedValueOnce({ data: catalogResponse }).mockResolvedValueOnce({ data: organizationPlanResponse })

    const configService = {
      get: jest.fn((key: string) => (key === 'billingApiUrl' ? 'https://commerce.test/api/billing' : 'shared-token')),
    }
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    }
    const service = new CommerceBoxLimitService(configService as never, redis as never)

    expect(organizationPlanResponse).toEqual({})
    await expect(service.resolveMaxCreatedBoxes('org-1')).resolves.toBe(2)
  })
})
