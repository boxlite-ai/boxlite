/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1780200000000 implements MigrationInterface {
  name = 'Migration1780200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."snapshot_name_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."snapshot_state_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."box_template_name_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."box_template_state_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."snapshot_runner_snapshotref_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."snapshot_runner_runnerid_snapshotref_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."snapshot_runner_runnerid_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."snapshot_runner_state_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."sandbox_snapshot_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."sandbox_template_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."warm_pool_find_idx"`)

    await this.renameColumnIfExists(queryRunner, 'snapshot', 'ref', 'artifactRef')
    await this.renameColumnIfExists(queryRunner, 'snapshot', 'buildInfoSnapshotRef', 'buildInfoArtifactRef')
    await this.renameTableIfExists(queryRunner, 'snapshot', 'saved_image')
    await this.renameTableIfExists(queryRunner, 'box_template', 'saved_image')
    await this.renameTableIfExists(queryRunner, 'snapshot_region', 'saved_image_region')
    await this.renameTableIfExists(queryRunner, 'box_template_region', 'saved_image_region')
    await this.renameColumnIfExists(queryRunner, 'saved_image_region', 'snapshotId', 'savedImageId')
    await this.renameColumnIfExists(queryRunner, 'saved_image_region', 'templateId', 'savedImageId')
    await this.renameEnumTypeForColumn(queryRunner, 'saved_image', 'state', 'saved_image_state_enum')

    await this.renameColumnIfExists(queryRunner, 'build_info', 'snapshotRef', 'artifactRef')
    await this.renameColumnIfExists(queryRunner, 'sandbox', 'buildInfoSnapshotRef', 'buildInfoArtifactRef')
    await this.renameColumnIfExists(queryRunner, 'sandbox', 'snapshot', 'savedImage')
    await this.renameColumnIfExists(queryRunner, 'sandbox', 'template', 'savedImage')
    await this.renameColumnIfExists(queryRunner, 'warm_pool', 'snapshot', 'savedImage')
    await this.renameColumnIfExists(queryRunner, 'warm_pool', 'template', 'savedImage')
    if (await queryRunner.hasColumn('organization', 'max_snapshot_size')) {
      await queryRunner.renameColumn('organization', 'max_snapshot_size', 'max_saved_image_size')
    }
    if (await queryRunner.hasColumn('organization', 'max_template_size')) {
      await queryRunner.renameColumn('organization', 'max_template_size', 'max_saved_image_size')
    }
    if (await queryRunner.hasColumn('organization', 'snapshot_quota')) {
      await queryRunner.renameColumn('organization', 'snapshot_quota', 'saved_image_quota')
    }
    if (await queryRunner.hasColumn('organization', 'template_quota')) {
      await queryRunner.renameColumn('organization', 'template_quota', 'saved_image_quota')
    }
    if (await queryRunner.hasColumn('organization', 'snapshot_deactivation_timeout_minutes')) {
      await queryRunner.renameColumn(
        'organization',
        'snapshot_deactivation_timeout_minutes',
        'saved_image_deactivation_timeout_minutes',
      )
    }
    if (await queryRunner.hasColumn('organization', 'template_deactivation_timeout_minutes')) {
      await queryRunner.renameColumn(
        'organization',
        'template_deactivation_timeout_minutes',
        'saved_image_deactivation_timeout_minutes',
      )
    }
    if (await queryRunner.hasColumn('region', 'snapshotManagerUrl')) {
      await queryRunner.renameColumn('region', 'snapshotManagerUrl', 'artifactRegistryUrl')
    }
    if (await queryRunner.hasColumn('runner', 'currentSnapshotCount')) {
      await queryRunner.renameColumn('runner', 'currentSnapshotCount', 'currentArtifactCount')
    }

    await this.renameTableIfExists(queryRunner, 'snapshot_runner', 'runner_artifact_cache')
    await this.renameColumnIfExists(queryRunner, 'runner_artifact_cache', 'snapshotRef', 'artifactRef')
    await this.renameEnumTypeForColumn(
      queryRunner,
      'runner_artifact_cache',
      'state',
      'runner_artifact_cache_state_enum',
    )
    await this.renameEnumValueIfExists(
      queryRunner,
      'runner_artifact_cache_state_enum',
      'pulling_snapshot',
      'pulling_artifact',
    )
    await this.renameEnumValueIfExists(
      queryRunner,
      'runner_artifact_cache_state_enum',
      'building_snapshot',
      'building_artifact',
    )
    await queryRunner.query(`ALTER TABLE "runner_artifact_cache" ALTER COLUMN "state" SET DEFAULT 'pulling_artifact'`)
    await this.renameEnumValueIfExists(queryRunner, 'sandbox_state_enum', 'pulling_snapshot', 'pulling_artifact')
    await this.renameEnumValueIfExists(queryRunner, 'sandbox_state_enum', 'building_snapshot', 'building_artifact')
    await this.renameEnumValueIfExists(queryRunner, 'job_resourcetype_enum', 'SNAPSHOT', 'ARTIFACT')
    await this.renameEnumValueIfExists(
      queryRunner,
      'organization_role_permissions_enum',
      'write:snapshots',
      'write:saved_images',
    )
    await this.renameEnumValueIfExists(
      queryRunner,
      'organization_role_permissions_enum',
      'write:templates',
      'write:saved_images',
    )
    await this.renameEnumValueIfExists(
      queryRunner,
      'organization_role_permissions_enum',
      'delete:snapshots',
      'delete:saved_images',
    )
    await this.renameEnumValueIfExists(
      queryRunner,
      'organization_role_permissions_enum',
      'delete:templates',
      'delete:saved_images',
    )
    await this.renameEnumValueIfExists(queryRunner, 'api_key_permissions_enum', 'write:snapshots', 'write:saved_images')
    await this.renameEnumValueIfExists(queryRunner, 'api_key_permissions_enum', 'write:templates', 'write:saved_images')
    await this.renameEnumValueIfExists(queryRunner, 'api_key_permissions_enum', 'delete:snapshots', 'delete:saved_images')
    await this.renameEnumValueIfExists(queryRunner, 'api_key_permissions_enum', 'delete:templates', 'delete:saved_images')
    await queryRunner.query(`
      UPDATE "organization_role"
      SET "name" = 'Saved Images Admin', "description" = 'Grants admin access to saved images in the organization'
      WHERE "name" IN ('Snapshots Admin', 'Templates Admin')
    `)
    await queryRunner.query(`
      UPDATE "job"
      SET "type" = CASE "type"
        WHEN 'BUILD_SNAPSHOT' THEN 'BUILD_ARTIFACT'
        WHEN 'PULL_SNAPSHOT' THEN 'PULL_ARTIFACT'
        WHEN 'REMOVE_SNAPSHOT' THEN 'REMOVE_ARTIFACT'
        WHEN 'INSPECT_SNAPSHOT_IN_REGISTRY' THEN 'INSPECT_ARTIFACT_IN_REGISTRY'
        ELSE "type"
      END
      WHERE "type" IN ('BUILD_SNAPSHOT', 'PULL_SNAPSHOT', 'REMOVE_SNAPSHOT', 'INSPECT_SNAPSHOT_IN_REGISTRY')
    `)

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "runner_artifact_cache_state_idx" ON "runner_artifact_cache" ("state")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "runner_artifact_cache_runnerid_idx" ON "runner_artifact_cache" ("runnerId")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "runner_artifact_cache_runnerid_artifactref_idx" ON "runner_artifact_cache" ("runnerId", "artifactRef")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "runner_artifact_cache_artifactref_idx" ON "runner_artifact_cache" ("artifactRef")`,
    )
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "saved_image_name_idx" ON "saved_image" ("name")`)
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "saved_image_state_idx" ON "saved_image" ("state")`)
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "sandbox_saved_image_idx" ON "sandbox" ("savedImage")`)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "warm_pool_find_idx" ON "warm_pool" ("savedImage", "target", "class", "cpu", "mem", "disk", "gpu", "osUser", "env")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."warm_pool_find_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."sandbox_saved_image_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."saved_image_state_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."saved_image_name_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."runner_artifact_cache_artifactref_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."runner_artifact_cache_runnerid_artifactref_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."runner_artifact_cache_runnerid_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."runner_artifact_cache_state_idx"`)

    await queryRunner.query(`
      UPDATE "job"
      SET "type" = CASE "type"
        WHEN 'BUILD_ARTIFACT' THEN 'BUILD_SNAPSHOT'
        WHEN 'PULL_ARTIFACT' THEN 'PULL_SNAPSHOT'
        WHEN 'REMOVE_ARTIFACT' THEN 'REMOVE_SNAPSHOT'
        WHEN 'INSPECT_ARTIFACT_IN_REGISTRY' THEN 'INSPECT_SNAPSHOT_IN_REGISTRY'
        ELSE "type"
      END
      WHERE "type" IN ('BUILD_ARTIFACT', 'PULL_ARTIFACT', 'REMOVE_ARTIFACT', 'INSPECT_ARTIFACT_IN_REGISTRY')
    `)
    await this.renameEnumValueIfExists(queryRunner, 'job_resourcetype_enum', 'ARTIFACT', 'SNAPSHOT')
    await queryRunner.query(`
      UPDATE "organization_role"
      SET "name" = 'Snapshots Admin', "description" = 'Grants admin access to snapshots in the organization'
      WHERE "name" = 'Saved Images Admin'
    `)
    await this.renameEnumValueIfExists(queryRunner, 'api_key_permissions_enum', 'delete:saved_images', 'delete:snapshots')
    await this.renameEnumValueIfExists(queryRunner, 'api_key_permissions_enum', 'write:saved_images', 'write:snapshots')
    await this.renameEnumValueIfExists(
      queryRunner,
      'organization_role_permissions_enum',
      'delete:saved_images',
      'delete:snapshots',
    )
    await this.renameEnumValueIfExists(
      queryRunner,
      'organization_role_permissions_enum',
      'write:saved_images',
      'write:snapshots',
    )
    await this.renameEnumValueIfExists(queryRunner, 'sandbox_state_enum', 'pulling_artifact', 'pulling_snapshot')
    await this.renameEnumValueIfExists(queryRunner, 'sandbox_state_enum', 'building_artifact', 'building_snapshot')
    await this.renameEnumValueIfExists(
      queryRunner,
      'runner_artifact_cache_state_enum',
      'pulling_artifact',
      'pulling_snapshot',
    )
    await this.renameEnumValueIfExists(
      queryRunner,
      'runner_artifact_cache_state_enum',
      'building_artifact',
      'building_snapshot',
    )
    await queryRunner.query(`ALTER TABLE "runner_artifact_cache" ALTER COLUMN "state" SET DEFAULT 'pulling_snapshot'`)
    await this.renameEnumTypeForColumn(queryRunner, 'runner_artifact_cache', 'state', 'snapshot_runner_state_enum')
    await this.renameColumnIfExists(queryRunner, 'runner_artifact_cache', 'artifactRef', 'snapshotRef')
    await this.renameTableIfExists(queryRunner, 'runner_artifact_cache', 'snapshot_runner')

    await this.renameColumnIfExists(queryRunner, 'build_info', 'artifactRef', 'snapshotRef')
    await this.renameColumnIfExists(queryRunner, 'sandbox', 'buildInfoArtifactRef', 'buildInfoSnapshotRef')
    await this.renameColumnIfExists(queryRunner, 'sandbox', 'savedImage', 'snapshot')
    await this.renameColumnIfExists(queryRunner, 'warm_pool', 'savedImage', 'snapshot')
    if (await queryRunner.hasColumn('organization', 'max_saved_image_size')) {
      await queryRunner.renameColumn('organization', 'max_saved_image_size', 'max_snapshot_size')
    }
    if (await queryRunner.hasColumn('organization', 'saved_image_quota')) {
      await queryRunner.renameColumn('organization', 'saved_image_quota', 'snapshot_quota')
    }
    if (await queryRunner.hasColumn('organization', 'saved_image_deactivation_timeout_minutes')) {
      await queryRunner.renameColumn(
        'organization',
        'saved_image_deactivation_timeout_minutes',
        'snapshot_deactivation_timeout_minutes',
      )
    }
    if (await queryRunner.hasColumn('region', 'artifactRegistryUrl')) {
      await queryRunner.renameColumn('region', 'artifactRegistryUrl', 'snapshotManagerUrl')
    }
    if (await queryRunner.hasColumn('runner', 'currentArtifactCount')) {
      await queryRunner.renameColumn('runner', 'currentArtifactCount', 'currentSnapshotCount')
    }

    await this.renameEnumTypeForColumn(queryRunner, 'saved_image', 'state', 'snapshot_state_enum')
    await this.renameColumnIfExists(queryRunner, 'saved_image_region', 'savedImageId', 'snapshotId')
    await this.renameTableIfExists(queryRunner, 'saved_image_region', 'snapshot_region')
    await this.renameColumnIfExists(queryRunner, 'saved_image', 'buildInfoArtifactRef', 'buildInfoSnapshotRef')
    await this.renameColumnIfExists(queryRunner, 'saved_image', 'artifactRef', 'ref')
    await this.renameTableIfExists(queryRunner, 'saved_image', 'snapshot')

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "snapshot_runner_state_idx" ON "snapshot_runner" ("state")`)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "snapshot_runner_runnerid_idx" ON "snapshot_runner" ("runnerId")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "snapshot_runner_runnerid_snapshotref_idx" ON "snapshot_runner" ("runnerId", "snapshotRef")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "snapshot_runner_snapshotref_idx" ON "snapshot_runner" ("snapshotRef")`,
    )
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "snapshot_state_idx" ON "snapshot" ("state")`)
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "snapshot_name_idx" ON "snapshot" ("name")`)
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "sandbox_snapshot_idx" ON "sandbox" ("snapshot")`)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "warm_pool_find_idx" ON "warm_pool" ("snapshot", "target", "class", "cpu", "mem", "disk", "gpu", "osUser", "env")`,
    )
  }

  private async renameTableIfExists(queryRunner: QueryRunner, from: string, to: string): Promise<void> {
    if ((await queryRunner.hasTable(from)) && !(await queryRunner.hasTable(to))) {
      await queryRunner.renameTable(from, to)
    }
  }

  private async renameColumnIfExists(
    queryRunner: QueryRunner,
    tableName: string,
    from: string,
    to: string,
  ): Promise<void> {
    if (!(await queryRunner.hasTable(tableName))) {
      return
    }

    if ((await queryRunner.hasColumn(tableName, from)) && !(await queryRunner.hasColumn(tableName, to))) {
      await queryRunner.renameColumn(tableName, from, to)
    }
  }

  private async renameEnumTypeForColumn(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
    targetTypeName: string,
  ): Promise<void> {
    const currentTypeName = await this.getEnumTypeForColumn(queryRunner, tableName, columnName)
    if (!currentTypeName || currentTypeName === targetTypeName) {
      return
    }

    if (await this.enumTypeExists(queryRunner, targetTypeName)) {
      return
    }

    await queryRunner.query(
      `ALTER TYPE "public".${this.quoteIdentifier(currentTypeName)} RENAME TO ${this.quoteIdentifier(targetTypeName)}`,
    )
  }

  private async getEnumTypeForColumn(
    queryRunner: QueryRunner,
    tableName: string,
    columnName: string,
  ): Promise<string | undefined> {
    const result = await queryRunner.query(
      `
        SELECT t.typname
        FROM pg_type t
        JOIN pg_attribute a ON a.atttypid = t.oid
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = $1
          AND a.attname = $2
          AND t.typtype = 'e'
          AND NOT a.attisdropped
        LIMIT 1
      `,
      [tableName, columnName],
    )

    return result[0]?.typname
  }

  private async enumTypeExists(queryRunner: QueryRunner, typeName: string): Promise<boolean> {
    const result = await queryRunner.query(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public'
            AND t.typname = $1
        ) AS "exists"
      `,
      [typeName],
    )

    return result[0]?.exists === true
  }

  private async renameEnumValueIfExists(
    queryRunner: QueryRunner,
    typeName: string,
    from: string,
    to: string,
  ): Promise<void> {
    const labels = await this.getEnumLabels(queryRunner, typeName)
    if (!labels.includes(from) || labels.includes(to)) {
      return
    }

    await queryRunner.query(
      `ALTER TYPE "public".${this.quoteIdentifier(typeName)} RENAME VALUE '${this.escapeLiteral(from)}' TO '${this.escapeLiteral(to)}'`,
    )
  }

  private async getEnumLabels(queryRunner: QueryRunner, typeName: string): Promise<string[]> {
    const result = await queryRunner.query(
      `
        SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typname = $1
      `,
      [typeName],
    )

    return result.map((row: { enumlabel: string }) => row.enumlabel)
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
  }

  private escapeLiteral(value: string): string {
    return value.replace(/'/g, "''")
  }
}
