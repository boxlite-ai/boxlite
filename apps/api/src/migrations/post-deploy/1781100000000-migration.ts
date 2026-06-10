/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Drops the self-hosted internal docker registry and the per-template multi-region
 * mapping from the schema.
 *
 * The runner now pulls private ghcr images directly with its runtime-scoped ghcr
 * auth, so the control plane keeps no per-pull registry rows. Templates are
 * region-agnostic, so the `box_template_region` join table is gone too. Dropping
 * the tables with CASCADE removes their FK constraints (e.g. the historical
 * `snapshot_region` FKs to `box_template`/`region`); the registry enum type is
 * then orphaned and dropped.
 *
 * Guards: every statement is `IF EXISTS` so the migration is idempotent and safe
 * on databases where a table/type was already absent.
 */
export class Migration1781100000000 implements MigrationInterface {
  name = 'Migration1781100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // CASCADE drops any FK constraints referencing these tables.
    await queryRunner.query(`DROP TABLE IF EXISTS "box_template_region" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "docker_registry" CASCADE`)
    // Orphaned enum type backing docker_registry."registryType".
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."docker_registry_registrytype_enum"`)
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Best-effort, intentionally a no-op. The self-hosted registry and per-template
    // region mapping are removed from the application; recreating empty tables
    // would not restore the data or the application code that populated them.
  }
}
