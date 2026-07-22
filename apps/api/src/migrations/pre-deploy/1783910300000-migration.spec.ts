/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1783910300000 } from './1783910300000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []
  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1783910300000', () => {
  it('creates subscription, quota, entitlement, and user multiplier records', async () => {
    const runner = new RecordingQueryRunner()
    await new Migration1783910300000().up(runner as unknown as QueryRunner)
    const sql = runner.queries.join('\n')
    expect(sql).toContain('CREATE TABLE "subscription_plan"')
    expect(sql).toContain("('starter', 1, 1900, 3000)")
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS "btree_gist"')
    expect(sql).toContain('CREATE TABLE "organization_subscription"')
    expect(sql).toContain('CREATE TABLE "subscription_period"')
    expect(sql).toContain('CONSTRAINT "subscription_period_org_no_overlap" EXCLUDE USING gist')
    expect(sql).toContain('CREATE TABLE "user_resource_multiplier"')
    expect(sql).toContain('CONSTRAINT "subscription_entitlement_period_no_overlap" EXCLUDE USING gist')
    expect(sql).toContain('CONSTRAINT "user_resource_multiplier_no_overlap" EXCLUDE USING gist')
    expect(sql).toContain('CREATE UNIQUE INDEX "user_resource_multiplier_current_idx"')
  })
})
