/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1784793600000 } from './1784793600000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1784793600000', () => {
  it('adds runtime fencing, durable leases, cleanup idempotency, and usage caps', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1784793600000().up(runner as unknown as QueryRunner)

    expect(runner.queries).toEqual(
      expect.arrayContaining([
        'ALTER TABLE "box" ADD "runtimeGeneration" bigint NOT NULL DEFAULT \'0\'',
        'ALTER TABLE "box" ADD "runtimeAuthorized" boolean NOT NULL DEFAULT false',
        'ALTER TABLE "runner" ADD "runtimeEpoch" uuid',
        'ALTER TABLE "runner" ADD "runtimeIncarnation" bigint NOT NULL DEFAULT \'0\'',
        expect.stringContaining('CONSTRAINT "box_usage_period_compute_cap"'),
        expect.stringContaining('CREATE TABLE "runner_runtime_epoch"'),
        expect.stringContaining('CREATE TABLE "box_runtime_lease"'),
        expect.stringContaining('CONSTRAINT "box_runtime_cleanup_target_uq" UNIQUE'),
      ]),
    )
    expect(runner.queries.at(-1)).toContain('box_runtime_cleanup_job_idx')
  })

  it('removes runtime lease schema in reverse dependency order', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1784793600000().down(runner as unknown as QueryRunner)

    expect(runner.queries.slice(0, 7)).toEqual([
      'DROP INDEX "box_runtime_cleanup_job_idx"',
      'DROP TABLE "box_runtime_cleanup"',
      'DROP INDEX "box_runtime_lease_runner_idx"',
      'DROP INDEX "box_runtime_lease_expiry_idx"',
      'DROP TABLE "box_runtime_lease"',
      'DROP INDEX "runner_runtime_epoch_current_idx"',
      'DROP TABLE "runner_runtime_epoch"',
    ])
    expect(runner.queries.at(-1)).toBe('ALTER TABLE "box" DROP COLUMN "runtimeGeneration"')
  })
})
