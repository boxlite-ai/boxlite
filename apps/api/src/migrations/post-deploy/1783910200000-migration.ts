/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1783910200000 implements MigrationInterface {
  name = 'Migration1783910200000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Ratings written by the old API during the rolling-deploy window still need
    // occurrence timestamps before these columns are contracted.
    await queryRunner.query(
      `UPDATE "rated_period" rated
       SET "billingUserId" = archive."billingUserId",
           "usageStartAt" = archive."startAt",
           "usageEndAt" = archive."endAt"
       FROM "box_usage_period_archive" archive
       WHERE archive.id = rated."usagePeriodArchiveId"
         AND (rated."usageStartAt" IS NULL
           OR rated."usageEndAt" IS NULL)`,
    )
    await queryRunner.query(`ALTER TABLE "rated_period" ALTER COLUMN "usageStartAt" SET NOT NULL`)
    await queryRunner.query(`ALTER TABLE "rated_period" ALTER COLUMN "usageEndAt" SET NOT NULL`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "rated_period" ALTER COLUMN "usageEndAt" DROP NOT NULL`)
    await queryRunner.query(`ALTER TABLE "rated_period" ALTER COLUMN "usageStartAt" DROP NOT NULL`)
  }
}
