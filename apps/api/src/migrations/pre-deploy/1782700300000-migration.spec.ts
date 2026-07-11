/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { QueryRunner } from 'typeorm'
import { Migration1782700300000 } from './1782700300000-migration'

class RecordingQueryRunner {
  readonly queries: string[] = []

  async query(sql: string): Promise<void> {
    this.queries.push(sql.replace(/\s+/g, ' ').trim())
  }
}

describe('Migration1782700300000', () => {
  it('adds payment state, top-up records, and a durable provider-event inbox', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1782700300000().up(runner as unknown as QueryRunner)

    const sql = runner.queries.join('\n')
    expect(sql).toContain('ALTER TABLE "wallet" ADD "paymentProviderCustomerId"')
    expect(sql).toContain('ALTER TABLE "wallet" ADD "autoReloadEnabled" boolean NOT NULL DEFAULT false')
    expect(sql).toContain('ALTER TABLE "wallet" ADD "autoReloadNextAttemptAt" TIMESTAMP WITH TIME ZONE')
    expect(sql).toContain('CREATE TABLE "top_up_record"')
    expect(sql).toContain('"status" character varying NOT NULL DEFAULT \'pending\'')
    expect(sql).toContain('CREATE UNIQUE INDEX "top_up_record_org_idempotency_idx"')
    expect(sql).toContain('CREATE TABLE "payment_provider_event"')
    expect(sql).toContain('CREATE UNIQUE INDEX "payment_provider_event_provider_id_idx"')
  })

  it('removes payment tables before wallet columns', async () => {
    const runner = new RecordingQueryRunner()

    await new Migration1782700300000().down(runner as unknown as QueryRunner)

    expect(runner.queries.slice(0, 2)).toEqual(['DROP TABLE "payment_provider_event"', 'DROP TABLE "top_up_record"'])
    expect(runner.queries.at(-1)).toBe('ALTER TABLE "wallet" DROP COLUMN "paymentProviderCustomerId"')
  })
})
