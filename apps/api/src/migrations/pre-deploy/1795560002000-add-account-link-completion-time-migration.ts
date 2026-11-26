/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAccountLinkCompletionTime1795560002000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "account_link_consent_job" ADD COLUMN "completed_at" timestamptz')
    await queryRunner.query(`
      UPDATE "account_link_consent_job" SET "completed_at" = statement_timestamp() WHERE "state" = 'done'
    `)
    await queryRunner.query(`
      CREATE INDEX "account_link_completed_source" ON "account_link_consent_job" ("source_id")
      WHERE "state" = 'done'
    `)
    // During rollout, existing API instances can still complete a link.
    await queryRunner.query(`
      CREATE FUNCTION stamp_account_link_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW."completed_at" := clock_timestamp();
        RETURN NEW;
      END;
      $$
    `)
    await queryRunner.query(`
      CREATE TRIGGER stamp_account_link_completion BEFORE UPDATE OF "state" ON "account_link_consent_job"
      FOR EACH ROW WHEN (OLD."state" <> 'done' AND NEW."state" = 'done')
      EXECUTE FUNCTION stamp_account_link_completion()
    `)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER stamp_account_link_completion ON "account_link_consent_job"')
    await queryRunner.query('DROP FUNCTION stamp_account_link_completion()')
    await queryRunner.query('DROP INDEX "account_link_completed_source"')
    await queryRunner.query('ALTER TABLE "account_link_consent_job" DROP COLUMN "completed_at"')
  }
}
