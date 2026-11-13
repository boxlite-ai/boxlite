import { ApiKeyService } from './api-key.service'
import { Context } from '../common/context/context'
import { apiKeyValidationCacheKey } from '../common/utils/api-key'

function fixture() {
  const rows: any[] = [],
    cache = new Map<string, string>()
  const repository = {
    findOne: jest.fn(
      async ({ where }) =>
        rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null,
    ),
    save: jest.fn(async (row) => {
      rows.push(row)
      return row
    }),
    find: jest.fn(async ({ where, take }) => rows.filter((row) => row.userId === where.userId).slice(0, take)),
    remove: jest.fn(async (keys) => {
      for (const key of keys) rows.splice(rows.indexOf(key), 1)
    }),
  }
  const redis = {
    del: jest.fn(async (key: string) => {
      cache.delete(key)
      return 1
    }),
  }
  const service = new ApiKeyService(
    repository as never,
    {} as never,
    redis as never,
    { getOrThrow: () => 'blk', get: () => false } as never,
  )
  const create = async (userId: string, org = 'org-a', name = String(rows.length)) => {
    const result = await service.createApiKey(org, userId, name, [], Context.admin())
    cache.set(apiKeyValidationCacheKey(result.apiKey.keyHash), 'cached validation')
    return result
  }
  return { service, rows, cache, redis, repository, create }
}

describe('user-wide API key cleanup', () => {
  it('deletes more than two batches across organizations, retaining other creators and clearing validation caches', async () => {
    const world = fixture()
    for (let index = 0; index < 501; index++) await world.create('target', `org-${index % 3}`)
    const other = await world.create('other', 'org-0')
    const result = await world.service.revokeUserKeys('target')
    expect(result).toEqual({ deleted: 501, complete: true })
    expect(world.rows).toEqual([other.apiKey])
    expect(world.cache.size).toBe(1)
    await expect(world.service.getApiKeyByValue(other.value)).resolves.toBe(other.apiKey)
    await expect(world.service.revokeUserKeys('target')).resolves.toEqual({ deleted: 0, complete: true })
  })
  it('reports cache or storage failures rather than claiming complete cleanup', async () => {
    const world = fixture()
    await world.create('target')
    world.redis.del.mockRejectedValueOnce(new Error('redis unavailable'))
    await expect(world.service.revokeUserKeys('target')).resolves.toEqual({ deleted: 1, complete: false })
    expect(world.rows).toHaveLength(0)
    world.repository.find.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(world.service.revokeUserKeys('target')).resolves.toEqual({ deleted: 0, complete: false })
  })
  it('does not start work after the cleanup deadline', async () => {
    const world = fixture()
    await world.create('target')
    await expect(world.service.revokeUserKeys('target', Date.now() - 1)).resolves.toEqual({
      deleted: 0,
      complete: false,
    })
    expect(world.rows).toHaveLength(1)
  })
})
