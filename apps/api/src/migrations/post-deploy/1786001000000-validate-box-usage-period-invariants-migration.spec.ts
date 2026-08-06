/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { QueryRunner } from 'typeorm'
import { ValidateBoxUsagePeriodInvariants1786001000000 } from './1786001000000-validate-box-usage-period-invariants-migration'

describe('ValidateBoxUsagePeriodInvariants1786001000000', () => {
  const queryRunner = (violations: Array<{ ledger: string; id: string }> = []) =>
    ({
      query: jest
        .fn()
        .mockImplementation(async (statement: string) =>
          statement.includes('SELECT ledger, id') ? violations : undefined,
        ),
    }) as unknown as QueryRunner

  it('preflights chronology before the deferred low-lock validation', async () => {
    const runner = queryRunner()

    await new ValidateBoxUsagePeriodInvariants1786001000000().up(runner)

    const statements = (runner.query as jest.Mock).mock.calls.map(([statement]) => statement as string)
    const preflight = statements.findIndex((statement) => statement.includes('SELECT ledger, id'))
    const validateLive = statements.findIndex((statement) =>
      statement.includes('VALIDATE CONSTRAINT "box_usage_periods_end_after_start_check"'),
    )
    const validateArchive = statements.findIndex((statement) =>
      statement.includes('VALIDATE CONSTRAINT "box_usage_periods_archive_end_after_start_check"'),
    )

    expect(statements).toEqual(expect.arrayContaining([expect.stringContaining("SET LOCAL lock_timeout = '5s'")]))
    expect(statements).toEqual(
      expect.arrayContaining([expect.stringContaining("SET LOCAL statement_timeout = '5min'")]),
    )
    expect(statements[preflight]).toContain('"endAt" < "startAt"')
    expect(statements[preflight]).not.toContain('"endAt" <= "startAt"')
    expect(statements[preflight]).toContain('LIMIT 1')
    expect(validateLive).toBeGreaterThan(preflight)
    expect(validateArchive).toBeGreaterThan(validateLive)
  })

  it('reports one actionable historical violation without attempting validation', async () => {
    const runner = queryRunner([{ ledger: 'box_usage_periods_archive', id: 'bad-period' }])

    await expect(new ValidateBoxUsagePeriodInvariants1786001000000().up(runner)).rejects.toThrow(
      /box_usage_periods_archive row bad-period ends before it starts/,
    )

    const sql = (runner.query as jest.Mock).mock.calls.map(([statement]) => statement).join('\n')
    expect(sql).not.toContain('VALIDATE CONSTRAINT')
  })

  it('does not remove checks when validation is reverted', async () => {
    const runner = queryRunner()

    await new ValidateBoxUsagePeriodInvariants1786001000000().down(runner)

    expect(runner.query).not.toHaveBeenCalled()
  })
})
