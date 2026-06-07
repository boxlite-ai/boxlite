import { RuntimeArtifactManager } from './runtime-artifact.manager'
import { RunnerArtifactCacheState } from '../enums/runner-artifact-cache-state.enum'

type QueryRecord = {
  alias: string
  selects: string[]
  joins: string[]
  conditions: string[]
}

function createQueryBuilder(alias: string, records: QueryRecord[], results: Record<string, unknown>[] = []) {
  const record: QueryRecord = { alias, selects: [], joins: [], conditions: [] }
  records.push(record)

  const builder = {
    select: jest.fn((selection: string) => {
      record.selects.push(selection)
      return builder
    }),
    leftJoin: jest.fn((_table: string, _alias: string, condition: string) => {
      record.joins.push(condition)
      return builder
    }),
    where: jest.fn((condition: string) => {
      record.conditions.push(condition)
      return builder
    }),
    andWhere: jest.fn((condition: string | (() => string)) => {
      record.conditions.push(typeof condition === 'function' ? condition() : condition)
      return builder
    }),
    andWhereExists: jest.fn((subquery: { getQuery: () => string }) => {
      record.conditions.push(`EXISTS (${subquery.getQuery()})`)
      return builder
    }),
    take: jest.fn(() => builder),
    getMany: jest.fn().mockResolvedValue(results),
    getRawMany: jest.fn().mockResolvedValue(results),
    getQuery: jest.fn(() => {
      return [...record.selects, ...record.joins, ...record.conditions].join('\n')
    }),
  }

  return builder
}

function createManager(queryResults: Record<string, unknown>[] = []) {
  const records: QueryRecord[] = []
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  const savedImageRepository = {
    createQueryBuilder: jest.fn((alias: string) => createQueryBuilder(alias, records, queryResults)),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
  }
  const runnerArtifactCacheRepository = {
    createQueryBuilder: jest.fn((alias: string) => createQueryBuilder(alias, records)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  }

  const manager = new RuntimeArtifactManager(
    { get: jest.fn(), set: jest.fn() } as any,
    savedImageRepository as any,
    runnerArtifactCacheRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    redisLockProvider as any,
    {} as any,
    {} as any,
    {} as any,
  )

  return { manager, records, runnerArtifactCacheRepository }
}

describe('RuntimeArtifactManager saved image cleanup SQL', () => {
  it('uses a lowercase saved_image alias when deactivating old saved images', async () => {
    const { manager, records } = createManager()

    await manager.deactivateOldSavedImages()

    const query = records.find((record) => record.alias === 'saved_image')
    expect(query).toBeDefined()
    const sql = [...query!.joins, ...query!.conditions].join('\n')
    expect(sql).toContain('saved_image."artifactRef"')
    expect(sql).not.toContain('savedImage."')
  })

  it('uses the same lowercase alias when finding inactive saved image artifacts to remove', async () => {
    const { manager, records, runnerArtifactCacheRepository } = createManager([{ artifactRef: 'registry/boxlite:old' }])

    await manager.cleanupInactiveSavedImagesFromRunners()

    const query = records.find((record) => record.alias === 'saved_image')
    expect(query).toBeDefined()
    const sql = [...query!.selects, ...query!.conditions].join('\n')
    expect(sql).toContain('saved_image."artifactRef"')
    expect(sql).not.toContain('savedImage."')
    expect(runnerArtifactCacheRepository.update).toHaveBeenCalledWith(
      { artifactRef: expect.any(Object) },
      { state: RunnerArtifactCacheState.REMOVING },
    )
  })
})
