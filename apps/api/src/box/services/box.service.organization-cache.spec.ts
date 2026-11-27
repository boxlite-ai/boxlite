/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BoxService } from './box.service'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'

describe('BoxService organization lookup cache', () => {
  function makeService(findOne: jest.Mock) {
    const boxRepository = { findOne }
    const boxLookupCacheInvalidationService = new BoxLookupCacheInvalidationService({
      queryResultCache: { remove: jest.fn().mockResolvedValue(undefined) },
    } as any)
    const service = Object.assign(Object.create(BoxService.prototype), {
      boxRepository,
      boxLookupCacheInvalidationService,
    }) as BoxService
    return { service, boxRepository }
  }

  it('serves repeated ID lookups from the local positive cache', async () => {
    const findOne = jest.fn().mockResolvedValue({ organizationId: 'org-1' })
    const { service } = makeService(findOne)

    await expect(service.getOrganizationId('box-1', 'org-1')).resolves.toBe('org-1')
    await expect(service.getOrganizationId('box-1', 'org-1')).resolves.toBe('org-1')

    expect(findOne).toHaveBeenCalledTimes(1)
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        select: ['organizationId'],
        cache: expect.objectContaining({ milliseconds: 120_000 }),
      }),
    )
  })

  it('uses a separate name fallback cache for each organization', async () => {
    const findOne = jest.fn(async (options) =>
      options.where.name === 'shared-name' ? { organizationId: options.where.organizationId } : null,
    )
    const { service } = makeService(findOne)

    await service.getOrganizationId('shared-name', 'org-1')
    await service.getOrganizationId('shared-name', 'org-1')
    expect(findOne).toHaveBeenCalledTimes(2)

    await service.getOrganizationId('shared-name', 'org-2')
    expect(findOne).toHaveBeenCalledTimes(4)
  })
})
