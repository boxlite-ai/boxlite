import { getMetadataArgsStorage, QueryRunner } from 'typeorm'
import { AddRunnerDiskExpansion1794528002000 } from '../../migrations/pre-deploy/1794528002000-add-runner-disk-expansion-migration'
import { AddRunnerDiskPerformanceUpdated1794528004000 } from '../../migrations/pre-deploy/1794528004000-add-runner-disk-performance-updated-migration'
import { RunnerDiskExpansion } from './runner-disk-expansion.entity'

describe('RunnerDiskExpansion schema metadata', () => {
  // The drift class this table shipped: the entity declared a
  // @CreateDateColumn createdAt the migration never creates. synchronize()
  // builds integration-test tables from the entity, so only a metadata-vs-
  // migration comparison catches such a column — on a migrated database every
  // find/insert through the repository failed on it. The comparison now
  // aggregates every migration that shapes this table's columns, so a
  // migration-added column keeps the same guard.
  it('maps exactly the columns the migrations create', async () => {
    const queryRunner = { query: jest.fn() } as unknown as QueryRunner
    await new AddRunnerDiskExpansion1794528002000().up(queryRunner)
    await new AddRunnerDiskPerformanceUpdated1794528004000().up(queryRunner)
    // The creation migration opens with CREATE TYPE for the status enum; the
    // table is a later call in the same up(). A later migration adds
    // "performanceUpdated" via ALTER TABLE.
    const calls = jest.mocked(queryRunner.query).mock.calls.map((call) => call[0] as string)
    const createTable = calls.find((sql) => sql.includes('CREATE TABLE "runner_disk_expansion"'))
    const alterTable = calls.find((sql) => sql.includes(`ADD "performanceUpdated"`))
    expect(createTable).toBeDefined()
    expect(alterTable).toBeDefined()

    // Column-definition lines open with a quoted name followed by a type;
    // constraint and index lines start with CONSTRAINT.
    const createdColumns = [
      ...[...createTable!.matchAll(/^\s*"([^"]+)"\s+\S/gm)].map((match) => match[1]),
      alterTable!.match(/ADD "([^"]+)"/)![1],
    ]
    const declaredColumns = getMetadataArgsStorage()
      .columns.filter((column) => column.target === RunnerDiskExpansion)
      .map((column) => column.propertyName)

    expect(declaredColumns.sort()).toEqual(createdColumns.sort())
  })
})
