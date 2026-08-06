import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Forward-only hardening for the usage ledger.
 *
 * New archives retain the UUID of their source period. Existing archives
 * cannot be reconstructed after the source row was deleted, so the new column
 * deliberately remains nullable and the unique index is partial. This avoids
 * a blocking full-table backfill during pre-deploy.
 *
 * CREATE/DROP INDEX CONCURRENTLY cannot run in a transaction. The migration
 * data sources use `migrationsTransactionMode: each`, and this migration opts
 * out so the live ledger remains writable while PostgreSQL builds the index.
 */
export class AddBoxUsagePeriodInvariants1786000000000 implements MigrationInterface {
  name = 'AddBoxUsagePeriodInvariants1786000000000'
  transaction = false

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Fail quickly instead of queueing an ACCESS EXCLUSIVE metadata lock
    // behind a long-running request. Every statement is rerunnable because a
    // nontransactional concurrent-index failure may leave earlier DDL applied.
    await queryRunner.query(`SET lock_timeout = '5s'`)
    try {
      await this.installBillingChangeTracking(queryRunner)

      await queryRunner.query(
        `ALTER TABLE "box_usage_periods_archive"
           ADD COLUMN IF NOT EXISTS "sourceUsagePeriodId" uuid`,
      )

      await this.ensureSourceIdentityIndex(queryRunner)
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "box_usage_periods_archive_box_start_uidx"`)

      // NOT VALID avoids an immediate scan of the historical ledgers while
      // still enforcing the checks for every new or changed row. The explicit
      // post-deploy validation migration performs a bounded preflight first.
      await queryRunner.query(`
        DO $migration$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'box_usage_periods_end_after_start_check'
              AND conrelid = 'box_usage_periods'::regclass
          ) THEN
            ALTER TABLE "box_usage_periods"
              ADD CONSTRAINT "box_usage_periods_end_after_start_check"
              CHECK ("endAt" IS NULL OR "endAt" >= "startAt") NOT VALID;
          END IF;
        END;
        $migration$
      `)
      await queryRunner.query(`
        DO $migration$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'box_usage_periods_archive_end_after_start_check'
              AND conrelid = 'box_usage_periods_archive'::regclass
          ) THEN
            ALTER TABLE "box_usage_periods_archive"
              ADD CONSTRAINT "box_usage_periods_archive_end_after_start_check"
              CHECK ("endAt" >= "startAt") NOT VALID;
          END IF;
        END;
        $migration$
      `)
    } finally {
      await queryRunner.query(`RESET lock_timeout`)
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET lock_timeout = '5s'`)
    try {
      await queryRunner.query(
        `ALTER TABLE "box_usage_periods_archive"
           DROP CONSTRAINT IF EXISTS "box_usage_periods_archive_end_after_start_check"`,
      )
      await queryRunner.query(
        `ALTER TABLE "box_usage_periods"
           DROP CONSTRAINT IF EXISTS "box_usage_periods_end_after_start_check"`,
      )
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "box_usage_periods_archive_source_period_uidx"`)
      await queryRunner.query(
        `ALTER TABLE "box_usage_periods_archive"
           DROP COLUMN IF EXISTS "sourceUsagePeriodId"`,
      )
      await this.removeBillingChangeTracking(queryRunner)
    } finally {
      await queryRunner.query(`RESET lock_timeout`)
    }
  }

  private async installBillingChangeTracking(queryRunner: QueryRunner): Promise<void> {
    // The dedicated boundary must be maintained below the ORM so raw SQL,
    // bulk updates, and future write paths cannot accidentally move it with an
    // unrelated updatedAt write or omit it from a billable transition.
    // Keep this short metadata transaction separate from the concurrent index
    // work below. The column and trigger become visible together, so no live
    // write can land between them. On retry, replacing the function leaves the
    // already-installed trigger continuously active.
    await queryRunner.startTransaction()
    try {
      await queryRunner.query(
        `ALTER TABLE "box"
           ADD COLUMN IF NOT EXISTS "billingChangedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`,
      )
      await queryRunner.query(
        `ALTER TABLE "box"
           ALTER COLUMN "billingChangedAt" SET DEFAULT CURRENT_TIMESTAMP`,
      )
      await queryRunner.query(`
        CREATE OR REPLACE FUNCTION set_box_billing_changed_at()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF ROW(
            NEW."state",
            NEW."cpu",
            NEW."gpu",
            NEW."mem",
            NEW."disk",
            NEW."organizationId",
            NEW."region"
          ) IS DISTINCT FROM ROW(
            OLD."state",
            OLD."cpu",
            OLD."gpu",
            OLD."mem",
            OLD."disk",
            OLD."organizationId",
            OLD."region"
          ) THEN
            NEW."billingChangedAt" := statement_timestamp();
          ELSE
            NEW."billingChangedAt" := OLD."billingChangedAt";
          END IF;
          RETURN NEW;
        END;
        $function$
      `)
      await queryRunner.query(`
        DO $migration$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'box_billing_changed_at_trigger'
              AND tgrelid = 'box'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER "box_billing_changed_at_trigger"
              BEFORE UPDATE ON "box"
              FOR EACH ROW
              EXECUTE FUNCTION set_box_billing_changed_at();
          END IF;
        END;
        $migration$
      `)
      await queryRunner.commitTransaction()
    } catch (error) {
      await queryRunner.rollbackTransaction()
      throw error
    }

    // This is intentionally an expand-only pre-deploy change. PostgreSQL's
    // fast default gives existing rows one safe deployment boundary without a
    // table rewrite. The nullable shape keeps retries safe; an explicit null is
    // repaired at observation time and never falls back to generic updatedAt.
  }

  private async removeBillingChangeTracking(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS "box_billing_changed_at_trigger" ON "box"`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS set_box_billing_changed_at()`)
    await queryRunner.query(
      `ALTER TABLE "box"
         DROP COLUMN IF EXISTS "billingChangedAt"`,
    )
  }

  private async ensureSourceIdentityIndex(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT pg_idx.indisvalid AS valid
         FROM pg_class relation
         JOIN pg_index pg_idx ON pg_idx.indexrelid = relation.oid
        WHERE relation.relname = 'box_usage_periods_archive_source_period_uidx'`,
    )) as Array<{ valid: boolean }> | undefined
    const existing = Array.isArray(rows) ? rows[0] : undefined

    // A failed CREATE INDEX CONCURRENTLY leaves an invalid index behind. Drop
    // only that invalid artifact so a migration retry can rebuild it safely;
    // a valid index is kept in place.
    if (existing && !existing.valid) {
      await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "box_usage_periods_archive_source_period_uidx"`)
    }
    if (!existing || !existing.valid) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX CONCURRENTLY "box_usage_periods_archive_source_period_uidx"
           ON "box_usage_periods_archive" ("sourceUsagePeriodId")
           WHERE "sourceUsagePeriodId" IS NOT NULL`,
      )
    }
  }
}
