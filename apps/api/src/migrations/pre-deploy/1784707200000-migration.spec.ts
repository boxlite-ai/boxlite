/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1784707200000 } from './1784707200000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1784707200000', () => {
  it('adds lifecycle idempotency and a non-negative usage duration constraint', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1784707200000().up(runner as unknown as QueryRunner)

    expect(runner.queries).toEqual([
      'ALTER TABLE "box" ADD "lifecycleJobId" uuid',
      'CREATE INDEX "box_lifecycle_job_idx" ON "box" ("lifecycleJobId") WHERE "lifecycleJobId" IS NOT NULL',
      'ALTER TABLE "box_usage_period" ADD CONSTRAINT "box_usage_period_non_negative_duration" CHECK ("endAt" IS NULL OR "endAt" >= "startAt")',
    ])
  })

  it('removes the constraint, index, and lifecycle column in dependency order', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1784707200000().down(runner as unknown as QueryRunner)

    expect(runner.queries).toEqual([
      'ALTER TABLE "box_usage_period" DROP CONSTRAINT "box_usage_period_non_negative_duration"',
      'DROP INDEX "box_lifecycle_job_idx"',
      'ALTER TABLE "box" DROP COLUMN "lifecycleJobId"',
    ])
  })
})
