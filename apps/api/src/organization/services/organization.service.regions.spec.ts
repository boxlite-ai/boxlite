/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RegionType } from '../../region/enums/region-type.enum'
import { OrganizationService } from './organization.service'

function createService() {
  const region = {
    id: 'local',
    name: 'Local',
    organizationId: null,
    regionType: RegionType.SHARED,
    enforceQuotas: false,
    createdAt: new Date('2026-07-10T00:00:00Z'),
    updatedAt: new Date('2026-07-10T00:00:00Z'),
    proxyUrl: null,
    sshGatewayUrl: null,
  }
  const queryBuilder = {
    where: jest.fn().mockReturnThis(),
    orWhere: jest.fn(function (clause: string) {
      if (clause.includes('region_quota')) {
        throw new Error('relation "region_quota" does not exist')
      }
      return this
    }),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([region]),
  }
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'organizationBoxDefaultLimitedNetworkEgress') return false
      throw new Error(`Unexpected config key: ${key}`)
    }),
  }
  const service = new OrganizationService(
    { manager: {} } as never,
    {} as never,
    {} as never,
    configService as never,
    {} as never,
    { createQueryBuilder: jest.fn(() => queryBuilder) } as never,
    {} as never,
    {} as never,
  )

  return { service, queryBuilder }
}

describe('OrganizationService.listAvailableRegions', () => {
  it('does not query the removed region quota table', async () => {
    const { service, queryBuilder } = createService()

    await expect(service.listAvailableRegions('org-1')).resolves.toEqual([
      expect.objectContaining({ id: 'local', regionType: RegionType.SHARED }),
    ])
    expect(queryBuilder.orWhere).toHaveBeenCalledTimes(1)
  })
})
