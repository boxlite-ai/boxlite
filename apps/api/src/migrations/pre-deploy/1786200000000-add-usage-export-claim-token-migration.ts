import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddUsageExportClaimToken1786200000000 implements MigrationInterface {
  name = 'AddUsageExportClaimToken1786200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box_usage_export_outbox" ADD "claimToken" uuid`)
    // During a rolling deploy, an older publisher does not know about the
    // token. Clear the token when that publisher changes only availableAt, so
    // a superseded new publisher cannot still satisfy its fencing predicate.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION clear_stale_usage_export_claim_token() RETURNS trigger AS $$
      BEGIN
        IF NEW."availableAt" IS DISTINCT FROM OLD."availableAt"
          AND NEW."claimToken" IS NOT DISTINCT FROM OLD."claimToken" THEN
          IF OLD."claimToken" IS NOT NULL
            AND (NEW."attempts" IS DISTINCT FROM OLD."attempts"
              OR NEW."lastError" IS DISTINCT FROM OLD."lastError"
              OR NEW."status" IS DISTINCT FROM OLD."status") THEN
            RAISE EXCEPTION 'stale usage export publisher cannot update a replacement claim';
          END IF;
          NEW."claimToken" = NULL;
        END IF;
        IF OLD."status" = 'pending' AND NEW."status" <> 'pending' AND NEW."claimToken" IS NOT NULL THEN
          RAISE EXCEPTION 'usage export terminal update must release its claim token';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await queryRunner.query(`
      CREATE TRIGGER "box_usage_export_outbox_claim_fence"
      BEFORE UPDATE ON "box_usage_export_outbox"
      FOR EACH ROW EXECUTE FUNCTION clear_stale_usage_export_claim_token()
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER "box_usage_export_outbox_claim_fence" ON "box_usage_export_outbox"`)
    await queryRunner.query(`DROP FUNCTION clear_stale_usage_export_claim_token()`)
    await queryRunner.query(`ALTER TABLE "box_usage_export_outbox" DROP COLUMN "claimToken"`)
  }
}
