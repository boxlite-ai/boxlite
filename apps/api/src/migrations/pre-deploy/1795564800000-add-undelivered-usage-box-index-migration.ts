/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

const INDEX_NAME = 'box_usage_export_outbox_undelivered_box_idx'

export class AddUndeliveredUsageBoxIndex1795564800000 implements MigrationInterface {
  transaction = false

  async up(queryRunner: QueryRunner): Promise<void> {
    const [existing] = await queryRunner.query('SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [
      INDEX_NAME,
    ])
    // Interrupted concurrent builds leave invalid indexes that IF NOT EXISTS would skip.
    if (existing?.indisvalid === false) await queryRunner.query(`DROP INDEX CONCURRENTLY ${INDEX_NAME}`)
    await queryRunner.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ON box_usage_export_outbox (("payload"->>'boxId')) WHERE "status" <> 'delivered'`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`)
  }
}
