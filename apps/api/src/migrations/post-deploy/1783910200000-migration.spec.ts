/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1783910200000 } from './1783910200000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1783910200000', () => {
  it('backfills rolling-deploy writes before contracting required columns', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1783910200000().up(runner as unknown as QueryRunner)

    expect(runner.queries[0]).toContain('UPDATE "rated_period" rated')
    expect(runner.queries[0]).toContain('rated."usageStartAt" IS NULL')
    expect(runner.queries.slice(1)).toEqual([
      'ALTER TABLE "rated_period" ALTER COLUMN "usageStartAt" SET NOT NULL',
      'ALTER TABLE "rated_period" ALTER COLUMN "usageEndAt" SET NOT NULL',
    ])
  })

  it('relaxes contracted columns in reverse order', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1783910200000().down(runner as unknown as QueryRunner)

    expect(runner.queries).toEqual([
      'ALTER TABLE "rated_period" ALTER COLUMN "usageEndAt" DROP NOT NULL',
      'ALTER TABLE "rated_period" ALTER COLUMN "usageStartAt" DROP NOT NULL',
    ])
  })
})
