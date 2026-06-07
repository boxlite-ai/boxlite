/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1780700000000 implements MigrationInterface {
  name = 'Migration1780700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."box_template_name_idx"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."box_template_state_idx"`)
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
    await this.renameEnumTypeForColumn(queryRunner, 'saved_image', 'state', 'saved_image_state_enum', 'pending')

    await this.renameColumnIfExists(queryRunner, 'sandbox', 'snapshot', 'savedImage')
    await this.renameColumnIfExists(queryRunner, 'sandbox', 'template', 'savedImage')
    await this.renameColumnIfExists(queryRunner, 'warm_pool', 'snapshot', 'savedImage')
    await this.renameColumnIfExists(queryRunner, 'warm_pool', 'template', 'savedImage')

    await this.renameColumnIfExists(queryRunner, 'organization', 'max_template_size', 'max_saved_image_size')
    await this.renameColumnIfExists(queryRunner, 'organization', 'template_quota', 'saved_image_quota')
    await this.renameColumnIfExists(
      queryRunner,
      'organization',
      'template_deactivation_timeout_minutes',
      'saved_image_deactivation_timeout_minutes',
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
      'delete:templates',
      'delete:saved_images',
    )
    await this.renameEnumValueIfExists(queryRunner, 'api_key_permissions_enum', 'write:templates', 'write:saved_images')
    await this.renameEnumValueIfExists(
      queryRunner,
      'api_key_permissions_enum',
      'delete:templates',
      'delete:saved_images',
    )

    await queryRunner.query(`
      UPDATE "organization_role"
      SET "name" = 'Saved Images Admin', "description" = 'Grants admin access to saved images in the organization'
      WHERE "name" = 'Templates Admin'
    `)

    await this.createIndexIfTableExists(queryRunner, 'saved_image', 'saved_image_name_idx', `"name"`)
    await this.createIndexIfTableExists(queryRunner, 'saved_image', 'saved_image_state_idx', `"state"`)
    await this.createIndexIfTableExists(queryRunner, 'sandbox', 'sandbox_saved_image_idx', `"savedImage"`)
    await this.createWarmPoolFindIndexIfReady(queryRunner)
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentionally no-op: this convergence migration only repairs environments
    // where an older migration record left schema names at the box_template layer.
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
    defaultValue?: string,
  ): Promise<void> {
    const currentTypeName = await this.getEnumTypeForColumn(queryRunner, tableName, columnName)
    if (!currentTypeName || currentTypeName === targetTypeName) {
      return
    }

    if (!(await this.enumTypeExists(queryRunner, targetTypeName))) {
      await queryRunner.query(
        `ALTER TYPE "public".${this.quoteIdentifier(currentTypeName)} RENAME TO ${this.quoteIdentifier(targetTypeName)}`,
      )
      return
    }

    const tableIdentifier = this.quoteIdentifier(tableName)
    const columnIdentifier = this.quoteIdentifier(columnName)
    const targetTypeIdentifier = `"public".${this.quoteIdentifier(targetTypeName)}`
    await queryRunner.query(`ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} DROP DEFAULT`)
    await queryRunner.query(
      `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} TYPE ${targetTypeIdentifier} USING ${columnIdentifier}::text::${targetTypeIdentifier}`,
    )
    if (defaultValue) {
      await queryRunner.query(
        `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} SET DEFAULT '${this.escapeLiteral(defaultValue)}'`,
      )
    }
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

  private async createIndexIfTableExists(
    queryRunner: QueryRunner,
    tableName: string,
    indexName: string,
    columns: string,
  ): Promise<void> {
    if (await queryRunner.hasTable(tableName)) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS ${this.quoteIdentifier(indexName)} ON ${this.quoteIdentifier(tableName)} (${columns})`,
      )
    }
  }

  private async createWarmPoolFindIndexIfReady(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('warm_pool')) || !(await queryRunner.hasColumn('warm_pool', 'savedImage'))) {
      return
    }

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "warm_pool_find_idx" ON "warm_pool" ("savedImage", "target", "class", "cpu", "mem", "disk", "gpu", "osUser", "env")`,
    )
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
  }

  private escapeLiteral(value: string): string {
    return value.replace(/'/g, "''")
  }
}
