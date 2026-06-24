/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxService } from './box.service'

const ORG = '057963b2-60ca-4356-81fc-11503e15f249'

function createService(boxRepository: any): BoxService {
  const service = Object.create(BoxService.prototype) as BoxService
  ;(service as any).boxRepository = boxRepository
  return service
}

describe('BoxService.listBoxesPageDeprecated', () => {
  it('fetches limit+1 rows (no COUNT) and reports hasMore when the extra row exists', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` }))
    const find = jest.fn().mockResolvedValue([...page, { id: 'overflow' }])
    const findAndCount = jest.fn()
    const service = createService({ find, findAndCount })

    const result = await service.listBoxesPageDeprecated(ORG, { limit: 100, offset: 200 })

    expect(findAndCount).not.toHaveBeenCalled()
    expect(result.hasMore).toBe(true)
    expect(result.items).toEqual(page)
    const arg = find.mock.calls[0][0]
    expect(arg.skip).toBe(200)
    expect(arg.take).toBe(101)
    expect(arg.order).toEqual({ createdAt: 'DESC' })
  })

  it('reports hasMore=false and returns all rows when the page is not full', async () => {
    const items = [{ id: 'b1' }, { id: 'b2' }]
    const find = jest.fn().mockResolvedValue(items)
    const service = createService({ find })

    const result = await service.listBoxesPageDeprecated(ORG, { limit: 100, offset: 0 })

    expect(result).toEqual({ items, hasMore: false })
  })

  it('scopes the query to the organization', async () => {
    const find = jest.fn().mockResolvedValue([])
    const service = createService({ find })

    await service.listBoxesPageDeprecated(ORG, { limit: 10, offset: 0 })

    const where = find.mock.calls[0][0].where
    expect(Array.isArray(where)).toBe(true)
    for (const clause of where) {
      expect(clause.organizationId).toBe(ORG)
    }
  })
})
