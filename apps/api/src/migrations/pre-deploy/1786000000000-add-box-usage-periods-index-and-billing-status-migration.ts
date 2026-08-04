import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Three additive changes to the usage-period tables, pre-deploy only.
 *
 * 1. Archive unique index: enforces at-most-one-archived-period-per-(boxId, startAt).
 *    Two archive rows for the same (boxId, startAt) would mean duplicate billing —
 *    the archive is the source of truth once a period is settled.
 *
 * 2. Org open-period index: `WHERE "organizationId" = $1 AND "endAt" IS NULL`.
 *    Latency-critical — runs on the synchronous path of a box create, so a
 *    sequential scan here slows provisioning for every customer.
 *
 * 3. `billing_status` column + partial index (a new nullable-with-default column
 *    is backwards compatible with the running API version). It is commerce-rs's
 *    billing queue flag on the archive table it reads and writes across services
 *    rather than a table it owns: this app only ever inserts the 'unbilled'
 *    default (BoxUsagePeriodArchive.fromUsagePeriod), never updates it.
 *    commerce-rs's billing cron claims a row with a compare-and-swap UPDATE
 *    ('unbilled' -> 'billed'); the partial index keeps that scan cheap by
 *    dropping billed rows out of it.
 */
export class AddBoxUsagePeriodsIndexAndBillingStatus1786000000000 implements MigrationInterface {
  name = 'AddBoxUsagePeriodsIndexAndBillingStatus1786000000000'

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

    // billing_status column + partial index on unbilled rows
    await queryRunner.query(
      `ALTER TABLE "box_usage_periods_archive"
         ADD COLUMN IF NOT EXISTS "billing_status" text NOT NULL DEFAULT 'unbilled'`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "box_usage_periods_archive_unbilled_idx"
         ON "box_usage_periods_archive" ("endAt") WHERE "billing_status" = 'unbilled'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "box_usage_periods_archive_unbilled_idx"`)
    await queryRunner.query(`ALTER TABLE "box_usage_periods_archive" DROP COLUMN IF EXISTS "billing_status"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_box_usage_periods_org_open"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "box_usage_periods_archive_box_start_uidx"`)
  }
}
