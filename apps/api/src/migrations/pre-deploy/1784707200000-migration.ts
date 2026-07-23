/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1784707200000 implements MigrationInterface {
  name = 'Migration1784707200000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "lifecycleJobId" uuid`)
    await queryRunner.query(
      `CREATE INDEX "box_lifecycle_job_idx" ON "box" ("lifecycleJobId") WHERE "lifecycleJobId" IS NOT NULL`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_usage_period" ADD CONSTRAINT "box_usage_period_non_negative_duration" CHECK ("endAt" IS NULL OR "endAt" >= "startAt")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box_usage_period" DROP CONSTRAINT "box_usage_period_non_negative_duration"`)
    await queryRunner.query(`DROP INDEX "box_lifecycle_job_idx"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "lifecycleJobId"`)
  }
}
