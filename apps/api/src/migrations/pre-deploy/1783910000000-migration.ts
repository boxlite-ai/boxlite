/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1783910000000 implements MigrationInterface {
  name = 'Migration1783910000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "box_usage_period_organization_end_idx"
       ON "box_usage_period" ("organizationId", "endAt")`,
    )
    await queryRunner.query(
      `CREATE INDEX "box_usage_period_archive_organization_end_idx"
       ON "box_usage_period_archive" ("organizationId", "endAt")`,
    )
    await queryRunner.query(
      `CREATE INDEX "box_billing_active_org_idx"
       ON "box" ("organizationId") WHERE "desiredState" = 'started'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "box_billing_active_org_idx"`)
    await queryRunner.query(`DROP INDEX "box_usage_period_archive_organization_end_idx"`)
    await queryRunner.query(`DROP INDEX "box_usage_period_organization_end_idx"`)
  }
}
