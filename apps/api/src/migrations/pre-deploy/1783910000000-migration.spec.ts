/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1783910000000 } from './1783910000000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1783910000000', () => {
  it('adds only the indexes required by billing access evaluation', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1783910000000().up(runner as unknown as QueryRunner)

    expect(runner.queries).toEqual([
      'CREATE INDEX "box_usage_period_organization_end_idx" ON "box_usage_period" ("organizationId", "endAt")',
      'CREATE INDEX "box_usage_period_archive_organization_end_idx" ON "box_usage_period_archive" ("organizationId", "endAt")',
      'CREATE INDEX "box_billing_active_org_idx" ON "box" ("organizationId") WHERE "desiredState" = \'started\'',
    ])
    expect(runner.queries.join('\n')).not.toContain('CREATE TABLE')
  })

  it('drops the billing access indexes in reverse order', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1783910000000().down(runner as unknown as QueryRunner)

    expect(runner.queries).toEqual([
      'DROP INDEX "box_billing_active_org_idx"',
      'DROP INDEX "box_usage_period_archive_organization_end_idx"',
      'DROP INDEX "box_usage_period_organization_end_idx"',
    ])
  })
})
