/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1782700100000 } from './1782700100000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1782700100000', () => {
  it('creates versioned pricing and one idempotent rated row per usage archive', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1782700100000().up(runner as unknown as QueryRunner)

    const sql = runner.queries.join('\n')
    expect(sql).toContain('CREATE TABLE "pricing_plan"')
    expect(sql).toContain('CREATE TABLE "rated_period"')
    expect(sql).toContain('"pricingSegments" jsonb NOT NULL')
    expect(sql).toContain('CREATE UNIQUE INDEX "rated_period_usage_archive_idx"')
    expect(sql).toContain('CONSTRAINT "pricing_plan_non_negative_rates" CHECK')
    expect(sql).toContain('0.0014')
    expect(sql).toContain('0.00045')
    expect(sql).toContain('0.000003')
    expect(sql).not.toContain('defaultGrantCents')
    expect(sql).not.toContain('warnThresholdCents')
  })

  it('drops the dependent rated table before pricing plans', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1782700100000().down(runner as unknown as QueryRunner)

    expect(runner.queries).toEqual(['DROP TABLE "rated_period"', 'DROP TABLE "pricing_plan"'])
  })
})
