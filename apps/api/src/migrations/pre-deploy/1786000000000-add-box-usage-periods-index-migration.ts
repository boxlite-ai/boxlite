import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Two additive indexes, pre-deploy only.
 *
 * 1. Archive unique index: enforces at-most-one-archived-period-per-(boxId, startAt).
 *    Two archive rows for the same (boxId, startAt) would mean duplicate billing —
 *    the archive is the source of truth once a period is settled.
 *
 * 2. Org open-period index: `WHERE "organizationId" = $1 AND "endAt" IS NULL`.
 *    Latency-critical — runs on the synchronous path of a box create, so a
 *    sequential scan here slows provisioning for every customer.
 */
export class AddBoxUsagePeriodsIndex1786000000000 implements MigrationInterface {
  name = 'AddBoxUsagePeriodsIndex1786000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Archive unique index
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "box_usage_periods_archive_box_start_uidx"
         ON "box_usage_periods_archive" ("boxId", "startAt")`,
    )

    // Org open-period index (partial — only open periods matter for affordability checks)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_box_usage_periods_org_open"
         ON "box_usage_periods" ("organizationId") WHERE "endAt" IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_box_usage_periods_org_open"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "box_usage_periods_archive_box_start_uidx"`)
  }
}
