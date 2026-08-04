import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Additive column + partial index, pre-deploy only (a new nullable-with-default
 * column is backwards compatible with the running API version).
 *
 * `billing_status` is commerce-rs's billing queue flag on the archive table it
 * reads and writes across services rather than a table it owns: this app only
 * ever inserts the 'unbilled' default (BoxUsagePeriodArchive.fromUsagePeriod),
 * never updates it. commerce-rs's billing cron claims a row with a
 * compare-and-swap UPDATE ('unbilled' -> 'billed'); the partial index keeps
 * that scan cheap by dropping billed rows out of it.
 */
export class AddBoxUsagePeriodsArchiveBillingStatus1786200000000 implements MigrationInterface {
  name = 'AddBoxUsagePeriodsArchiveBillingStatus1786200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
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
  }
}
