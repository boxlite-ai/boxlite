/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Removes the sandbox backup / restore / cross-runner-migration capability from
 * the schema.
 *
 * The runner-side backup path was an unimplemented stub, so `backupState` never
 * advanced past its default and every backup-gated code path was dead. Dropping
 * the index first, then the columns, then the enum type leaves the schema with
 * no dangling references.
 */
export class Migration1781000000000 implements MigrationInterface {
  name = 'Migration1781000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "sandbox_backupstate_idx"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "backupState"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "backupSnapshot"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "backupRegistryId"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "lastBackupAt"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "backupErrorReason"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "existingBackupSnapshots"`)
    // The enum type predates the workspace->sandbox / snapshotState->backupState
    // renames, which do not rename the underlying Postgres type. Drop both the
    // historical and the TypeORM-derived names so no orphan type is left behind.
    await queryRunner.query(`DROP TYPE IF EXISTS "workspace_snapshotstate_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "sandbox_backupstate_enum"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort restore of the dropped columns, index, and enum type. The
    // historical type name is reused since `up` dropped it under that name.
    await queryRunner.query(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workspace_snapshotstate_enum') THEN
          CREATE TYPE "workspace_snapshotstate_enum" AS ENUM ('None', 'Pending', 'InProgress', 'Completed', 'Error');
        END IF;
      END $$;`,
    )
    await queryRunner.query(
      `ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "backupState" "workspace_snapshotstate_enum" NOT NULL DEFAULT 'None'`,
    )
    await queryRunner.query(`ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "backupSnapshot" character varying`)
    await queryRunner.query(`ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "backupRegistryId" character varying`)
    await queryRunner.query(`ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "lastBackupAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "backupErrorReason" text`)
    await queryRunner.query(
      `ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "existingBackupSnapshots" jsonb NOT NULL DEFAULT '[]'`,
    )
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "sandbox_backupstate_idx" ON "sandbox" ("backupState")`)
  }
}
