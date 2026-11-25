/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAccountLinkAttempts1795560001000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "account_link_attempt" (
        "id" uuid PRIMARY KEY,
        "operation_id" uuid NOT NULL REFERENCES "account_link_consent_job" ("id") ON DELETE CASCADE,
        "dispatch_until" timestamptz NOT NULL,
        "rejected" boolean NOT NULL DEFAULT false
      )
    `)
    await queryRunner.query(`
      CREATE INDEX "account_link_attempt_operation_dispatch"
      ON "account_link_attempt" ("operation_id", "dispatch_until" DESC)
    `)
    await queryRunner.query(`
      INSERT INTO "account_link_attempt" ("id", "operation_id", "dispatch_until", "rejected")
      SELECT "id", "id", "created_at" + interval '30 seconds', "state" = 'failed' FROM "account_link_consent_job"
    `)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "account_link_attempt"')
  }
}
