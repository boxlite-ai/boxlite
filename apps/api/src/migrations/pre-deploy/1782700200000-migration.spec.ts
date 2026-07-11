/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1782700200000 } from './1782700200000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1782700200000', () => {
  it('creates the wallet state and an immutable idempotent transaction ledger', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1782700200000().up(runner as unknown as QueryRunner)

    const sql = runner.queries.join('\n')
    expect(sql).toContain('CREATE TABLE "wallet"')
    expect(sql).toContain('"settlementRemainderCents" numeric(38,18)')
    expect(sql).toContain('"freeExpiresAt" TIMESTAMP WITH TIME ZONE')
    expect(sql).toContain('CONSTRAINT "wallet_free_balance_non_negative" CHECK')
    expect(sql).toContain('CONSTRAINT "wallet_remainder_range" CHECK')
    expect(sql).toContain('CREATE UNIQUE INDEX "wallet_organization_idx"')
    expect(sql).toContain('CREATE TABLE "wallet_transaction"')
    expect(sql).toContain('CREATE UNIQUE INDEX "wallet_transaction_rated_period_idx"')
    expect(sql).toContain('CREATE TRIGGER "wallet_transaction_immutable"')
    expect(sql).not.toContain('top_up_record')
    expect(sql).not.toContain('providerEventId')
  })

  it('drops the ledger before wallet state and then removes its trigger function', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1782700200000().down(runner as unknown as QueryRunner)

    expect(runner.queries).toEqual([
      'DROP TABLE "wallet_transaction"',
      'DROP TABLE "wallet"',
      'DROP FUNCTION "reject_wallet_transaction_mutation"()',
    ])
  })
})
