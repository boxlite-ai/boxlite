/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1782700400000 } from './1782700400000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1782700400000', () => {
  it('adds durable payment recovery and immutable provider adjustments without a new table', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1782700400000().up(runner as unknown as QueryRunner)

    const sql = runner.queries.join('\n')
    expect(sql).toContain('ALTER TABLE "wallet" ADD "paymentSetupAttemptId"')
    expect(sql).toContain('ALTER TABLE "wallet" ADD "paymentSetupNextReconcileAt"')
    expect(sql).toContain('ALTER TABLE "top_up_record" ADD "reconcileAttempts" integer NOT NULL DEFAULT 0')
    expect(sql).toContain('ALTER TABLE "top_up_record" ADD "refundedCents" bigint NOT NULL DEFAULT 0')
    expect(sql).toContain('ALTER TABLE "top_up_record" ADD "disputedCents" bigint NOT NULL DEFAULT 0')
    expect(sql).toContain(
      'ALTER TABLE "payment_provider_event" ADD "status" character varying NOT NULL DEFAULT \'processed\'',
    )
    expect(sql).toContain('ALTER TABLE "payment_provider_event" ADD "payload" jsonb')
    expect(sql).toContain('ALTER TABLE "wallet_transaction" ADD "providerActionId" character varying')
    expect(sql).toContain('CREATE INDEX "top_up_record_reconcile_due_idx"')
    expect(sql).toContain('CREATE INDEX "payment_provider_event_retry_due_idx"')
    expect(sql).toContain('CREATE UNIQUE INDEX "wallet_transaction_provider_action_idx"')
    expect(sql).not.toContain('CREATE TABLE')
  })

  it('drops recovery indexes before their columns', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1782700400000().down(runner as unknown as QueryRunner)

    expect(runner.queries.slice(0, 4)).toEqual([
      'DROP INDEX "wallet_transaction_provider_action_idx"',
      'DROP INDEX "payment_provider_event_retry_due_idx"',
      'DROP INDEX "wallet_payment_setup_reconcile_due_idx"',
      'DROP INDEX "top_up_record_reconcile_due_idx"',
    ])
    expect(runner.queries.at(-1)).toBe('ALTER TABLE "wallet" DROP COLUMN "paymentSetupAttemptId"')
  })
})
