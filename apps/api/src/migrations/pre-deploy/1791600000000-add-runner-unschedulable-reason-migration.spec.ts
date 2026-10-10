import { QueryRunner } from 'typeorm'
import { AddRunnerUnschedulableReason1791600000000 } from './1791600000000-add-runner-unschedulable-reason-migration'

describe('AddRunnerUnschedulableReason1791600000000', () => {
  it('labels existing marks as operator marks and drops the column on rollback', async () => {
    const runner = { query: jest.fn() } as unknown as QueryRunner
    const migration = new AddRunnerUnschedulableReason1791600000000()

    await migration.up(runner)
    expect(runner.query).toHaveBeenCalledWith(
      `UPDATE "runner" SET "unschedulableReason" = 'operator' WHERE "unschedulable" = true`,
    )

    await migration.down(runner)
    expect(runner.query).toHaveBeenLastCalledWith(`DROP TYPE "public"."runner_unschedulablereason_enum"`)
  })
})
