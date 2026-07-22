/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1783910100000 } from './1783910100000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1783910100000', () => {
  it('expands and backfills the billing contract without early not-null constraints', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1783910100000().up(runner as unknown as QueryRunner)

    const sql = runner.queries.join('\n')
    expect(sql).toContain('ALTER TABLE "box" ADD "billingUserId" character varying')
    expect(sql).toContain('SET "billingUserId" = archive."billingUserId"')
    expect(sql).toContain('"usageStartAt" = archive."startAt"')
    expect(sql).toContain('CREATE INDEX "rated_period_org_usage_start_idx"')
    expect(sql).not.toContain('SET NOT NULL')
  })

  it('drops the expanded schema in dependency-safe order', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1783910100000().down(runner as unknown as QueryRunner)

    expect(runner.queries[0]).toBe('DROP INDEX "rated_period_org_usage_start_idx"')
    expect(runner.queries.at(-1)).toBe('ALTER TABLE "box" DROP COLUMN "billingUserId"')
  })
})
