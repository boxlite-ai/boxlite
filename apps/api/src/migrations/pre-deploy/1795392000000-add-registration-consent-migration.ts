/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRegistrationConsent1795392000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "registration_consent" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" character varying NOT NULL,
        "tos_version" text NOT NULL,
        "privacy_version" text NOT NULL,
        "accepted_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "registration_consent_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "registration_consent_user_id_unique" UNIQUE ("user_id")
      )
    `)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "registration_consent"')
  }
}
