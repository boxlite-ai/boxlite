import { QueryRunner } from 'typeorm'
import { AddRunnerUnschedulableReason1791600000000 } from './1791600000000-add-runner-unschedulable-reason-migration'

describe('AddRunnerUnschedulableReason1791600000000', () => {
  it('creates the single-value reason enum and drops it on rollback', async () => {
    const runner = { query: jest.fn() } as unknown as QueryRunner
    const migration = new AddRunnerUnschedulableReason1791600000000()

    await migration.up(runner)
    expect(runner.query).toHaveBeenCalledWith(
      `CREATE TYPE "public"."runner_unschedulablereason_enum" AS ENUM('disk_expand_exhausted')`,
    )
    // Existing marks stay reasonless: the operator endpoint never wrote the
    // column, and the cron keys on the reason to lift only its own marks.
    expect(runner.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE'))

    await migration.down(runner)
    expect(runner.query).toHaveBeenLastCalledWith(`DROP TYPE "public"."runner_unschedulablereason_enum"`)
  })
})
