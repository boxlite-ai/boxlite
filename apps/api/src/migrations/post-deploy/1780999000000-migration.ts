/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Removes the user-Dockerfile build capability from the schema.
 *
 * The MVP only pulls prebuilt images, so the runner-side build path and its
 * persistence are dead weight. Dropping the FK columns first lets Postgres
 * remove the dependent foreign-key constraints automatically before the
 * referenced `build_info` table is dropped.
 */
export class Migration1780999000000 implements MigrationInterface {
  name = 'Migration1780999000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Dropping a column also drops any FK constraint that references it.
    await queryRunner.query(`ALTER TABLE "box_template" DROP COLUMN IF EXISTS "buildInfoArtifactRef"`)
    await queryRunner.query(`ALTER TABLE "sandbox" DROP COLUMN IF EXISTS "buildInfoArtifactRef"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "build_info"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort restore: recreate the table and the nullable FK columns.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "build_info" (` +
        `"artifactRef" character varying NOT NULL, ` +
        `"dockerfileContent" text, ` +
        `"contextHashes" text, ` +
        `"lastUsedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `"updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "build_info_artifactRef_pk" PRIMARY KEY ("artifactRef"))`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_template" ADD COLUMN IF NOT EXISTS "buildInfoArtifactRef" character varying`,
    )
    await queryRunner.query(`ALTER TABLE "sandbox" ADD COLUMN IF NOT EXISTS "buildInfoArtifactRef" character varying`)
    await queryRunner.query(
      `ALTER TABLE "box_template" ADD CONSTRAINT "box_template_buildInfoArtifactRef_fk" ` +
        `FOREIGN KEY ("buildInfoArtifactRef") REFERENCES "build_info"("artifactRef") ` +
        `ON DELETE NO ACTION ON UPDATE NO ACTION`,
    )
    await queryRunner.query(
      `ALTER TABLE "sandbox" ADD CONSTRAINT "sandbox_buildInfoArtifactRef_fk" ` +
        `FOREIGN KEY ("buildInfoArtifactRef") REFERENCES "build_info"("artifactRef") ` +
        `ON DELETE NO ACTION ON UPDATE NO ACTION`,
    )
  }
}
