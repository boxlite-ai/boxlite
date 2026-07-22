/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1783910100000 implements MigrationInterface {
  name = 'Migration1783910100000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "billingUserId" character varying`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" ADD "billingUserId" character varying`)
    await queryRunner.query(`ALTER TABLE "box_usage_period_archive" ADD "billingUserId" character varying`)

    await queryRunner.query(`ALTER TABLE "rated_period" ADD "billingUserId" character varying`)
    await queryRunner.query(`ALTER TABLE "rated_period" ADD "usageStartAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "rated_period" ADD "usageEndAt" TIMESTAMP WITH TIME ZONE`)

    await queryRunner.query(
      `UPDATE "rated_period" rated
       SET "billingUserId" = archive."billingUserId",
           "usageStartAt" = archive."startAt",
           "usageEndAt" = archive."endAt"
       FROM "box_usage_period_archive" archive
       WHERE archive.id = rated."usagePeriodArchiveId"`,
    )

    await queryRunner.query(
      `CREATE INDEX "rated_period_org_usage_start_idx"
       ON "rated_period" ("organizationId", "usageStartAt", "id")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "rated_period_org_usage_start_idx"`)
    await queryRunner.query(`ALTER TABLE "rated_period" DROP COLUMN "usageEndAt"`)
    await queryRunner.query(`ALTER TABLE "rated_period" DROP COLUMN "usageStartAt"`)
    await queryRunner.query(`ALTER TABLE "rated_period" DROP COLUMN "billingUserId"`)

    await queryRunner.query(`ALTER TABLE "box_usage_period_archive" DROP COLUMN "billingUserId"`)
    await queryRunner.query(`ALTER TABLE "box_usage_period" DROP COLUMN "billingUserId"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "billingUserId"`)
  }
}
