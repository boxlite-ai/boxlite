import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Deferred validation for the NOT VALID checks installed before deployment.
 *
 * VALIDATE CONSTRAINT uses a lower-impact lock than adding an immediately
 * valid check, so normal reads and writes can continue. A read-only preflight
 * returns one actionable row before PostgreSQL takes that validation lock.
 */
export class ValidateBoxUsagePeriodInvariants1786001000000 implements MigrationInterface {
  name = 'ValidateBoxUsagePeriodInvariants1786001000000'
  transaction = true

  public async up(queryRunner: QueryRunner): Promise<void> {
    // The explicit post-deploy runner uses one transaction per migration.
    // Bound both lock acquisition and the historical scan so deployment never
    // waits indefinitely behind another DDL operation or a pathological table.
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`)
    await queryRunner.query(`SET LOCAL statement_timeout = '5min'`)

    const violations = (await queryRunner.query(`
      SELECT ledger, id
      FROM (
        SELECT 'box_usage_periods' AS ledger, "id"::text AS id
        FROM "box_usage_periods"
        WHERE "endAt" IS NOT NULL AND "endAt" < "startAt"
        UNION ALL
        SELECT 'box_usage_periods_archive' AS ledger, "id"::text AS id
        FROM "box_usage_periods_archive"
        WHERE "endAt" < "startAt"
      ) violation
      LIMIT 1
    `)) as Array<{ ledger: string; id: string }> | undefined

    if (Array.isArray(violations) && violations.length > 0) {
      const [{ ledger, id }] = violations
      throw new Error(`cannot validate usage chronology: ${ledger} row ${id} ends before it starts`)
    }

    await queryRunner.query(
      `ALTER TABLE "box_usage_periods"
         VALIDATE CONSTRAINT "box_usage_periods_end_after_start_check"`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_usage_periods_archive"
         VALIDATE CONSTRAINT "box_usage_periods_archive_end_after_start_check"`,
    )
  }

  // PostgreSQL has no inverse of VALIDATE CONSTRAINT. The pre-deploy rollback
  // owns removal of the checks themselves.
  public async down(queryRunner: QueryRunner): Promise<void> {
    void queryRunner
  }
}
