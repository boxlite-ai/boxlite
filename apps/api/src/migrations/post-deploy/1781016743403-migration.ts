/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Renames the physical Postgres schema from the legacy `sandbox*` vocabulary to
 * `box*` so the relations, columns, enum type, and indexes match the renamed
 * TypeORM entities (Box, BoxLastActivity, BoxUsagePeriod, BoxUsagePeriodArchive).
 *
 * This is a contract (post-deploy) migration: it must run after every node is
 * already serving the box-entity code, because the entity metadata pins the
 * `box*` names and would otherwise diverge from the live schema.
 *
 * Guards: each statement uses an existence guard (ALTER ... IF EXISTS, or a
 * catalog-checked DO block for objects that lack IF EXISTS) so re-running a
 * partially-applied migration is safe.
 *
 * Enum note: the `box_active_only_idx` partial index predicate casts to the
 * enum type (`::sandbox_state_enum`). Postgres stores that predicate by enum
 * OID, not by name, so `ALTER TYPE ... RENAME` is transparent to the existing
 * index. The enum is renamed first for logical coherence with the entity pins.
 */
export class Migration1781016743403 implements MigrationInterface {
  name = 'Migration1781016743403'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Enum type rename (must cohere with partial-index predicates).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sandbox_state_enum')
           AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'box_state_enum') THEN
          ALTER TYPE "sandbox_state_enum" RENAME TO "box_state_enum";
        END IF;
      END $$;
    `)

    // 2. Table renames.
    await queryRunner.query(`ALTER TABLE IF EXISTS "sandbox" RENAME TO "box"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "sandbox_last_activity" RENAME TO "box_last_activity"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "sandbox_usage_periods" RENAME TO "box_usage_periods"`)
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "sandbox_usage_periods_archive" RENAME TO "box_usage_periods_archive"`,
    )

    // 3. Column renames: "sandboxId" -> "boxId".
    await queryRunner.query(`ALTER TABLE IF EXISTS "box_last_activity" RENAME COLUMN "sandboxId" TO "boxId"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "ssh_access" RENAME COLUMN "sandboxId" TO "boxId"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "box_usage_periods" RENAME COLUMN "sandboxId" TO "boxId"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "box_usage_periods_archive" RENAME COLUMN "sandboxId" TO "boxId"`)

    // 4. Organization rate-limit columns.
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "sandbox_create_rate_limit" TO "box_create_rate_limit"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "sandbox_lifecycle_rate_limit" TO "box_lifecycle_rate_limit"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "sandbox_create_rate_limit_ttl_seconds" TO "box_create_rate_limit_ttl_seconds"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "sandbox_lifecycle_rate_limit_ttl_seconds" TO "box_lifecycle_rate_limit_ttl_seconds"`,
    )

    // 5. Organization quota columns (entity @Column names: max_cpu_per_box, max_memory_per_box, max_disk_per_box).
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "max_cpu_per_sandbox" TO "max_cpu_per_box"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "max_memory_per_sandbox" TO "max_memory_per_box"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "max_disk_per_sandbox" TO "max_disk_per_box"`,
    )

    // 6. Index renames: sandbox_*_idx -> box_*_idx (same suffix).
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_state_idx" RENAME TO "box_state_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_desiredstate_idx" RENAME TO "box_desiredstate_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_snapshot_idx" RENAME TO "box_snapshot_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_runnerid_idx" RENAME TO "box_runnerid_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_runner_state_idx" RENAME TO "box_runner_state_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_organizationid_idx" RENAME TO "box_organizationid_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_region_idx" RENAME TO "box_region_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_resources_idx" RENAME TO "box_resources_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_backupstate_idx" RENAME TO "box_backupstate_idx"`)
    await queryRunner.query(
      `ALTER INDEX IF EXISTS "sandbox_runner_state_desired_idx" RENAME TO "box_runner_state_desired_idx"`,
    )
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_active_only_idx" RENAME TO "box_active_only_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_pending_idx" RENAME TO "box_pending_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "sandbox_labels_gin_full_idx" RENAME TO "box_labels_gin_full_idx"`)

    // 7. Indexes with the `idx_sandbox_*` prefix variant (entity pins: idx_box_*).
    await queryRunner.query(`ALTER INDEX IF EXISTS "idx_sandbox_authtoken" RENAME TO "idx_box_authtoken"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "idx_sandbox_volumes_gin" RENAME TO "idx_box_volumes_gin"`)
    await queryRunner.query(
      `ALTER INDEX IF EXISTS "idx_sandbox_usage_periods_sandbox_end" RENAME TO "idx_box_usage_periods_box_end"`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order of up(): indexes, quota cols, rate-limit cols, columns, tables, enum.

    // 7. `idx_box_*` prefix variant back.
    await queryRunner.query(
      `ALTER INDEX IF EXISTS "idx_box_usage_periods_box_end" RENAME TO "idx_sandbox_usage_periods_sandbox_end"`,
    )
    await queryRunner.query(`ALTER INDEX IF EXISTS "idx_box_volumes_gin" RENAME TO "idx_sandbox_volumes_gin"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "idx_box_authtoken" RENAME TO "idx_sandbox_authtoken"`)

    // 6. Index renames back.
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_labels_gin_full_idx" RENAME TO "sandbox_labels_gin_full_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_pending_idx" RENAME TO "sandbox_pending_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_active_only_idx" RENAME TO "sandbox_active_only_idx"`)
    await queryRunner.query(
      `ALTER INDEX IF EXISTS "box_runner_state_desired_idx" RENAME TO "sandbox_runner_state_desired_idx"`,
    )
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_backupstate_idx" RENAME TO "sandbox_backupstate_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_resources_idx" RENAME TO "sandbox_resources_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_region_idx" RENAME TO "sandbox_region_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_organizationid_idx" RENAME TO "sandbox_organizationid_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_runner_state_idx" RENAME TO "sandbox_runner_state_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_runnerid_idx" RENAME TO "sandbox_runnerid_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_snapshot_idx" RENAME TO "sandbox_snapshot_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_desiredstate_idx" RENAME TO "sandbox_desiredstate_idx"`)
    await queryRunner.query(`ALTER INDEX IF EXISTS "box_state_idx" RENAME TO "sandbox_state_idx"`)

    // 5. Organization quota columns back.
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "max_disk_per_box" TO "max_disk_per_sandbox"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "max_memory_per_box" TO "max_memory_per_sandbox"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "max_cpu_per_box" TO "max_cpu_per_sandbox"`,
    )

    // 4. Organization rate-limit columns back.
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "box_lifecycle_rate_limit_ttl_seconds" TO "sandbox_lifecycle_rate_limit_ttl_seconds"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "box_create_rate_limit_ttl_seconds" TO "sandbox_create_rate_limit_ttl_seconds"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "box_lifecycle_rate_limit" TO "sandbox_lifecycle_rate_limit"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "box_create_rate_limit" TO "sandbox_create_rate_limit"`,
    )

    // 3. Column renames back: "boxId" -> "sandboxId".
    await queryRunner.query(`ALTER TABLE IF EXISTS "box_usage_periods_archive" RENAME COLUMN "boxId" TO "sandboxId"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "box_usage_periods" RENAME COLUMN "boxId" TO "sandboxId"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "ssh_access" RENAME COLUMN "boxId" TO "sandboxId"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "box_last_activity" RENAME COLUMN "boxId" TO "sandboxId"`)

    // 2. Table renames back.
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "box_usage_periods_archive" RENAME TO "sandbox_usage_periods_archive"`,
    )
    await queryRunner.query(`ALTER TABLE IF EXISTS "box_usage_periods" RENAME TO "sandbox_usage_periods"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "box_last_activity" RENAME TO "sandbox_last_activity"`)
    await queryRunner.query(`ALTER TABLE IF EXISTS "box" RENAME TO "sandbox"`)

    // 1. Enum type rename back.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'box_state_enum')
           AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sandbox_state_enum') THEN
          ALTER TYPE "box_state_enum" RENAME TO "sandbox_state_enum";
        END IF;
      END $$;
    `)
  }
}
