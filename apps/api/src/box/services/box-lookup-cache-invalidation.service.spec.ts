/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { boxOrgIdCacheKeyById } from '../utils/box-lookup-cache.util'

describe('BoxLookupCacheInvalidationService organization cache', () => {
  function makeService() {
    const remove = jest.fn().mockResolvedValue(undefined)
    const service = new BoxLookupCacheInvalidationService({ queryResultCache: { remove } } as any)
    return { service, remove }
  }

  it('coalesces loads, reuses positive results, and expires them after 120 seconds', async () => {
    const { service } = makeService()
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const loader = jest.fn().mockResolvedValue('org-1')
    const key = boxOrgIdCacheKeyById({ id: 'box-1', organizationId: 'org-1' })
    try {
      await expect(Promise.all([service.getOrganizationId(key, loader), service.getOrganizationId(key, loader)])).resolves.toEqual([
        'org-1',
        'org-1',
      ])
      await expect(service.getOrganizationId(key, loader)).resolves.toBe('org-1')
      expect(loader).toHaveBeenCalledTimes(1)

      now.mockReturnValue(121_000)
      await expect(service.getOrganizationId(key, loader)).resolves.toBe('org-1')
      expect(loader).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('does not cache missing boxes', async () => {
    const { service } = makeService()
    const loader = jest.fn().mockResolvedValue(null)
    const key = boxOrgIdCacheKeyById({ id: 'missing' })

    await expect(service.getOrganizationId(key, loader)).resolves.toBeNull()
    await expect(service.getOrganizationId(key, loader)).resolves.toBeNull()
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('invalidates local and shared ID and name variants', async () => {
    const { service, remove } = makeService()
    const key = boxOrgIdCacheKeyById({ id: 'box-1', organizationId: 'org-1' })
    await service.getOrganizationId(key, async () => 'org-1')

    service.invalidateOrgId({ id: 'box-1', organizationId: 'org-1', name: 'old-name' })
    const loader = jest.fn().mockResolvedValue('org-1')
    await service.getOrganizationId(key, loader)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith(expect.arrayContaining([key]))
  })
})
