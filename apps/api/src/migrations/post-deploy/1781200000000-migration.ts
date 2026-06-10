/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Drift-independent rebuild of the two surviving artifact tables: `box_template`
 * and `runner_artifact_cache`.
 *
 * Background: dev RDS sits on a divergent "saved_image" naming lineage while this
 * branch is on the "box_template" lineage. Earlier box_template migrations shared
 * names with the dev lineage, so they were recorded as already-run and skipped on
 * dev, leaving the schema drifted. A brand-new migration name always runs exactly
 * once, so this migration force-converges any prior state (saved_image lineage,
 * box_template lineage, or empty) to the identical clean final shape.
 *
 * Strategy: drop every legacy naming variant of the two tables and their join /
 * child tables (CASCADE removes any surviving FK, e.g. the historical
 * `snapshot_region` -> `snapshot` constraint), drop the orphaned enum types, then
 * recreate the two tables, enums, indexes, and the unique constraint exactly as
 * the current entity definitions require.
 *
 * Every statement is guarded (IF EXISTS / IF NOT EXISTS / pg_catalog checks) so the
 * migration is idempotent and safe regardless of which tables/types pre-exist.
 */
export class Migration1781200000000 implements MigrationInterface {
  name = 'Migration1781200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // uuid_generate_v4() default below depends on this extension.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)

    // 1. Drop every legacy naming variant. Child / join + cache tables first so the
    //    parent drops do not trip over dependents; CASCADE clears any surviving FK.
    await queryRunner.query(`DROP TABLE IF EXISTS "box_template_region" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "snapshot_region" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "saved_image_region" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "docker_registry" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "build_info" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "runner_artifact_cache" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "snapshot_runner" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "saved_image_runner" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "image_node" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "box_template" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "snapshot" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "saved_image" CASCADE`)
    await queryRunner.query(`DROP TABLE IF EXISTS "image" CASCADE`)

    // 2. Drop every enum variant once its backing tables are gone.
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."box_template_state_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."snapshot_state_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."saved_image_state_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."image_state_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."runner_artifact_cache_state_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."snapshot_runner_state_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."saved_image_runner_state_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."image_node_state_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."docker_registry_registrytype_enum"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."docker_registry_registrytype_enum_old"`)

    // 3. Recreate the two enum types (CREATE TYPE has no IF NOT EXISTS).
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'box_template_state_enum') THEN
          CREATE TYPE "public"."box_template_state_enum" AS ENUM (
            'pending', 'pulling', 'active', 'inactive', 'error', 'removing'
          );
        END IF;
      END $$;
    `)
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'runner_artifact_cache_state_enum') THEN
          CREATE TYPE "public"."runner_artifact_cache_state_enum" AS ENUM (
            'pulling_artifact', 'ready', 'error', 'removing'
          );
        END IF;
      END $$;
    `)

    // 4. Recreate the two tables to match the current entity definitions.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "box_template" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid,
        "general" boolean NOT NULL DEFAULT false,
        "name" character varying NOT NULL,
        "imageName" character varying NOT NULL DEFAULT '',
        "artifactRef" character varying,
        "state" "public"."box_template_state_enum" NOT NULL DEFAULT 'pending',
        "errorReason" character varying,
        "size" double precision,
        "cpu" integer NOT NULL DEFAULT 1,
        "gpu" integer NOT NULL DEFAULT 0,
        "mem" integer NOT NULL DEFAULT 1,
        "disk" integer NOT NULL DEFAULT 3,
        "hideFromUsers" boolean NOT NULL DEFAULT false,
        "entrypoint" text[],
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastUsedAt" TIMESTAMP,
        "initialRunnerId" character varying,
        CONSTRAINT "box_template_pkey" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "runner_artifact_cache" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "state" "public"."runner_artifact_cache_state_enum" NOT NULL DEFAULT 'pulling_artifact',
        "errorReason" character varying,
        "artifactRef" character varying NOT NULL DEFAULT '',
        "runnerId" character varying NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "runner_artifact_cache_pkey" PRIMARY KEY ("id")
      )
    `)

    // 5. Recreate indexes and the unique constraint.
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "box_template_name_idx" ON "box_template" ("name")`)
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "box_template_state_idx" ON "box_template" ("state")`)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "runner_artifact_cache_artifactref_idx" ON "runner_artifact_cache" ("artifactRef")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "runner_artifact_cache_runnerid_artifactref_idx" ON "runner_artifact_cache" ("runnerId", "artifactRef")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "runner_artifact_cache_runnerid_idx" ON "runner_artifact_cache" ("runnerId")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "runner_artifact_cache_state_idx" ON "runner_artifact_cache" ("state")`,
    )

    // @Unique(['organizationId', 'name']) on BoxTemplate. ADD CONSTRAINT has no
    // IF NOT EXISTS, so guard against re-adding when the constraint already exists.
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'box_template_organizationId_name_unique'
        ) THEN
          ALTER TABLE "box_template"
            ADD CONSTRAINT "box_template_organizationId_name_unique" UNIQUE ("organizationId", "name");
        END IF;
      END $$;
    `)
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Best-effort, intentionally a no-op. This migration force-rebuilds the surviving
    // tables to converge a drifted database; the prior multi-table legacy state
    // (saved_image / snapshot / image lineages with their region, registry, and
    // build_info dependents) is not reconstructable and should not be recreated.
  }
}
