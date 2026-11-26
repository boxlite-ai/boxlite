// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCheckpointKind1795564800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "checkpoint"
      ADD COLUMN "kind" varchar NOT NULL DEFAULT 'disk',
      ADD COLUMN "memorySizeBytes" bigint,
      ADD CONSTRAINT "checkpoint_kind_check" CHECK ("kind" IN ('disk','full')),
      ADD CONSTRAINT "checkpoint_memory_size_bytes_check" CHECK ("memorySizeBytes" IS NULL OR "memorySizeBytes" >= 0)`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN
      LOCK TABLE "checkpoint" IN ACCESS EXCLUSIVE MODE;
      IF EXISTS (SELECT 1 FROM "checkpoint" WHERE "kind" = 'full') THEN
        RAISE EXCEPTION 'Delete full checkpoints before reverting checkpoint kind storage';
      END IF;
      ALTER TABLE "checkpoint"
        DROP CONSTRAINT "checkpoint_kind_check",
        DROP CONSTRAINT "checkpoint_memory_size_bytes_check",
        DROP COLUMN "kind",
        DROP COLUMN "memorySizeBytes";
    END; $$`)
  }
}
