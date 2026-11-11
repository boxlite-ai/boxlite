import { getMetadataArgsStorage, QueryRunner } from 'typeorm'
import { AddRunnerDiskExpansion1794528002000 } from '../../migrations/pre-deploy/1794528002000-add-runner-disk-expansion-migration'
import { RunnerDiskExpansion } from './runner-disk-expansion.entity'

describe('RunnerDiskExpansion schema metadata', () => {
  // The drift class this table shipped: the entity declared a
  // @CreateDateColumn createdAt the migration never creates. synchronize()
  // builds integration-test tables from the entity, so only a metadata-vs-
  // migration comparison catches such a column — on a migrated database every
  // find/insert through the repository failed on it.
  it('maps exactly the columns the migration creates', async () => {
    const queryRunner = { query: jest.fn() } as unknown as QueryRunner
    await new AddRunnerDiskExpansion1794528002000().up(queryRunner)
    // The migration opens with CREATE TYPE for the status enum; the table is
    // a later call in the same up().
    const createTable = jest
      .mocked(queryRunner.query)
      .mock.calls.map((call) => call[0] as string)
      .find((sql) => sql.includes('CREATE TABLE "runner_disk_expansion"'))
    expect(createTable).toBeDefined()

    // Column-definition lines open with a quoted name followed by a type;
    // constraint and index lines start with CONSTRAINT.
    const createdColumns = [...createTable!.matchAll(/^\s*"([^"]+)"\s+\S/gm)].map((match) => match[1])
    const declaredColumns = getMetadataArgsStorage()
      .columns.filter((column) => column.target === RunnerDiskExpansion)
      .map((column) => column.propertyName)

    expect(declaredColumns.sort()).toEqual(createdColumns.sort())
  })
})
