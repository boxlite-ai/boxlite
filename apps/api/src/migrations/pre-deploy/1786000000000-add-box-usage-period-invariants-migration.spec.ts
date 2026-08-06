/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryRunner } from 'typeorm'
import { baseDataSourceOptions } from '../data-source'
import { AddBoxUsagePeriodInvariants1786000000000 } from './1786000000000-add-box-usage-period-invariants-migration'

describe('AddBoxUsagePeriodInvariants1786000000000', () => {
  const queryRunner = (indexState: Array<{ valid: boolean }> = [], failurePattern?: string) => {
    const runner = {
      query: jest.fn().mockImplementation(async (statement: string) => {
        if (failurePattern && statement.includes(failurePattern)) {
          throw new Error('injected migration failure')
        }
        return statement.includes('pg_idx.indisvalid') ? indexState : undefined
      }),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      commitTransaction: jest.fn().mockResolvedValue(undefined),
      rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    }
    return runner as unknown as QueryRunner
  }

  it('uses nontransactional online DDL and leaves historical checks for post-deploy validation', async () => {
    const runner = queryRunner()
    const migration = new AddBoxUsagePeriodInvariants1786000000000()

    await migration.up(runner)

    const sql = (runner.query as jest.Mock).mock.calls.map(([statement]) => statement).join('\n')
    expect(migration.transaction).toBe(false)
    expect(baseDataSourceOptions.migrationsTransactionMode).toBe('each')
    expect(runner.startTransaction).toHaveBeenCalledTimes(1)
    expect(runner.commitTransaction).toHaveBeenCalledTimes(1)
    expect(runner.rollbackTransaction).not.toHaveBeenCalled()
    const concurrentIndexCall = (runner.query as jest.Mock).mock.calls.findIndex(([statement]) =>
      statement.includes('CREATE UNIQUE INDEX CONCURRENTLY'),
    )
    expect((runner.commitTransaction as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      (runner.query as jest.Mock).mock.invocationCallOrder[concurrentIndexCall],
    )
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "sourceUsagePeriodId" uuid')
    expect(sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY "box_usage_periods_archive_source_period_uidx"')
    expect(sql).toContain('ON "box_usage_periods_archive" ("sourceUsagePeriodId")')
    expect(sql).toContain('WHERE "sourceUsagePeriodId" IS NOT NULL')
    expect(sql).toContain('DROP INDEX CONCURRENTLY IF EXISTS "box_usage_periods_archive_box_start_uidx"')
    expect(sql).toContain('CONSTRAINT "box_usage_periods_end_after_start_check"')
    expect(sql).toContain('"endAt" IS NULL OR "endAt" >= "startAt"')
    expect(sql).toContain('CONSTRAINT "box_usage_periods_archive_end_after_start_check"')
    expect(sql).toContain('"endAt" >= "startAt"')
    expect(sql.match(/NOT VALID/g)).toHaveLength(2)
    expect(sql).not.toContain('VALIDATE CONSTRAINT "box_usage_periods_end_after_start_check"')
    expect(sql).not.toContain('VALIDATE CONSTRAINT "box_usage_periods_archive_end_after_start_check"')
    expect(sql).not.toMatch(/UPDATE\s+"box_usage_periods_archive"/)
  })

  it('tracks only billing-relevant box transitions below every write path', async () => {
    const runner = queryRunner()

    await new AddBoxUsagePeriodInvariants1786000000000().up(runner)

    const sql = (runner.query as jest.Mock).mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain(
      'ADD COLUMN IF NOT EXISTS "billingChangedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP',
    )
    expect(sql).toContain('CREATE OR REPLACE FUNCTION set_box_billing_changed_at()')
    expect(sql).toContain('CREATE TRIGGER "box_billing_changed_at_trigger"')
    expect(sql).toContain('BEFORE UPDATE ON "box"')
    expect(sql).toContain('statement_timestamp()')
    for (const field of ['state', 'cpu', 'gpu', 'mem', 'disk', 'organizationId', 'region']) {
      expect(sql).toContain(`NEW."${field}"`)
      expect(sql).toContain(`OLD."${field}"`)
    }
    expect(sql).not.toContain('NEW."updatedAt"')
    expect(sql).not.toContain('OLD."updatedAt"')
    expect(sql).not.toMatch(/UPDATE\s+"box"/)
    expect(sql).not.toContain('ALTER COLUMN "billingChangedAt" SET NOT NULL')
  })

  it('rolls back the atomic Box metadata install on a statement failure', async () => {
    const runner = queryRunner([], 'CREATE OR REPLACE FUNCTION')

    await expect(new AddBoxUsagePeriodInvariants1786000000000().up(runner)).rejects.toThrow(
      'injected migration failure',
    )

    expect(runner.startTransaction).toHaveBeenCalledTimes(1)
    expect(runner.commitTransaction).not.toHaveBeenCalled()
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(runner.query).toHaveBeenLastCalledWith('RESET lock_timeout')
  })

  it('rebuilds an invalid artifact left by an interrupted concurrent index build', async () => {
    const runner = queryRunner([{ valid: false }])

    await new AddBoxUsagePeriodInvariants1786000000000().up(runner)

    const statements = (runner.query as jest.Mock).mock.calls.map(([statement]) => statement as string)
    const drop = statements.findIndex((statement) =>
      statement.includes('DROP INDEX CONCURRENTLY IF EXISTS "box_usage_periods_archive_source_period_uidx"'),
    )
    const create = statements.findIndex((statement) =>
      statement.includes('CREATE UNIQUE INDEX CONCURRENTLY "box_usage_periods_archive_source_period_uidx"'),
    )
    expect(drop).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(drop)
  })

  it('keeps an already-valid source identity index on a migration retry', async () => {
    const runner = queryRunner([{ valid: true }])

    await new AddBoxUsagePeriodInvariants1786000000000().up(runner)

    const sql = (runner.query as jest.Mock).mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).not.toContain('CREATE UNIQUE INDEX CONCURRENTLY "box_usage_periods_archive_source_period_uidx"')
    expect(sql).not.toContain('DROP INDEX CONCURRENTLY IF EXISTS "box_usage_periods_archive_source_period_uidx"')
  })

  it('removes only the forward migration invariants on rollback', async () => {
    const runner = queryRunner()

    await new AddBoxUsagePeriodInvariants1786000000000().down(runner)

    const sql = (runner.query as jest.Mock).mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "box_usage_periods_archive_end_after_start_check"')
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "box_usage_periods_end_after_start_check"')
    expect(sql).toContain('DROP INDEX CONCURRENTLY IF EXISTS "box_usage_periods_archive_source_period_uidx"')
    expect(sql).toContain('DROP COLUMN IF EXISTS "sourceUsagePeriodId"')
    expect(sql).toContain('DROP TRIGGER IF EXISTS "box_billing_changed_at_trigger" ON "box"')
    expect(sql).toContain('DROP FUNCTION IF EXISTS set_box_billing_changed_at()')
    expect(sql).toContain('DROP COLUMN IF EXISTS "billingChangedAt"')
    expect(sql).not.toContain('DROP TABLE')
  })
})
