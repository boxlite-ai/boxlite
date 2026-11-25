/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAccountLinkConsentJobs1795560000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "user" ADD COLUMN "registrationConsentPending" boolean NOT NULL DEFAULT false')
    await queryRunner.query('ALTER TABLE "registration_consent" ADD COLUMN "accepted_by_user_id" varchar')
    await queryRunner.query(`
      CREATE TABLE "account_link_consent_job" (
        "id" uuid PRIMARY KEY,
        "source_id" varchar NOT NULL,
        "target_id" varchar NOT NULL,
        "state" text NOT NULL DEFAULT 'pending' CHECK ("state" IN ('pending', 'done', 'failed')),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "next_check_at" timestamptz NOT NULL DEFAULT now() + interval '1 minute',
        "attempts" integer NOT NULL DEFAULT 0,
        "lease_token" uuid,
        "lease_expires_at" timestamptz,
        CHECK ("source_id" <> "target_id")
      )
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "account_link_consent_active_source"
      ON "account_link_consent_job" ("source_id") WHERE "state" = 'pending'
    `)
    await queryRunner.query(`
      CREATE INDEX "account_link_consent_target"
      ON "account_link_consent_job" ("target_id") WHERE "state" = 'pending'
    `)
    await queryRunner.query(`
      CREATE INDEX "account_link_consent_due"
      ON "account_link_consent_job" ("next_check_at", "id") WHERE "state" = 'pending'
    `)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "account_link_consent_job"')
    await queryRunner.query('ALTER TABLE "registration_consent" DROP COLUMN "accepted_by_user_id"')
    await queryRunner.query('ALTER TABLE "user" DROP COLUMN "registrationConsentPending"')
  }
}
