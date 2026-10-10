import { MigrationInterface, QueryRunner } from 'typeorm'

// Expand half of replacing the Daytona-era network flags (`public`,
// `networkBlockAll`, `networkAllowList`) with the policy columns the `/v1`
// contract speaks (`inboundMode`, `outboundMode`, `outboundAllowNet`). The
// types change, so this is add-backfill-sync rather than a column rename. The
// trigger keeps both shapes equal while old and new API instances overlap; the
// post-deploy migration drops it with the old columns.
export class ReplaceBoxNetworkFlags1790400000000 implements MigrationInterface {
  name = 'ReplaceBoxNetworkFlags1790400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "inboundMode" character varying NOT NULL DEFAULT 'disabled'`)
    await queryRunner.query(`ALTER TABLE "box" ADD "outboundMode" character varying NOT NULL DEFAULT 'enabled'`)
    await queryRunner.query(`ALTER TABLE "box" ADD "outboundAllowNet" text[]`)
    // Comma-joined list -> trimmed entries; null when nothing is listed. Shared
    // by the backfill and the trigger so both split the same way.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION box_allow_net_from_list(list text)
      RETURNS text[] AS $$
        SELECT NULLIF(
          ARRAY(SELECT btrim(entry) FROM unnest(string_to_array(list, ',')) AS entry WHERE btrim(entry) <> ''),
          '{}'::text[]
        )
      $$ LANGUAGE sql IMMUTABLE
    `)
    await queryRunner.query(`
      UPDATE "box" SET
        "inboundMode" = CASE WHEN "public" THEN 'enabled' ELSE 'disabled' END,
        "outboundMode" = CASE WHEN "networkBlockAll" THEN 'disabled' ELSE 'enabled' END,
        "outboundAllowNet" = box_allow_net_from_list("networkAllowList")
    `)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION sync_box_network_policy()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."inboundMode" IS DISTINCT FROM OLD."inboundMode" THEN
            NEW."public" := NEW."inboundMode" = 'enabled';
          ELSIF NEW."public" IS DISTINCT FROM OLD."public" THEN
            NEW."inboundMode" := CASE WHEN NEW."public" THEN 'enabled' ELSE 'disabled' END;
          END IF;
          IF NEW."outboundMode" IS DISTINCT FROM OLD."outboundMode" THEN
            NEW."networkBlockAll" := NEW."outboundMode" = 'disabled';
          ELSIF NEW."networkBlockAll" IS DISTINCT FROM OLD."networkBlockAll" THEN
            NEW."outboundMode" := CASE WHEN NEW."networkBlockAll" THEN 'disabled' ELSE 'enabled' END;
          END IF;
          IF NEW."outboundAllowNet" IS DISTINCT FROM OLD."outboundAllowNet" THEN
            NEW."networkAllowList" := array_to_string(NEW."outboundAllowNet", ',');
          ELSIF NEW."networkAllowList" IS DISTINCT FROM OLD."networkAllowList" THEN
            NEW."outboundAllowNet" := box_allow_net_from_list(NEW."networkAllowList");
          END IF;
        ELSE
          -- INSERT: whichever shape the writer filled in carries the value;
          -- the other still holds its column default.
          NEW."public" := NEW."public" OR NEW."inboundMode" = 'enabled';
          NEW."inboundMode" := CASE WHEN NEW."public" THEN 'enabled' ELSE 'disabled' END;
          NEW."networkBlockAll" := NEW."networkBlockAll" OR NEW."outboundMode" = 'disabled';
          NEW."outboundMode" := CASE WHEN NEW."networkBlockAll" THEN 'disabled' ELSE 'enabled' END;
          IF NEW."outboundAllowNet" IS NOT NULL THEN
            NEW."networkAllowList" := array_to_string(NEW."outboundAllowNet", ',');
          ELSIF NEW."networkAllowList" IS NOT NULL THEN
            NEW."outboundAllowNet" := box_allow_net_from_list(NEW."networkAllowList");
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await queryRunner.query(`
      CREATE TRIGGER box_network_policy_sync
      BEFORE INSERT OR UPDATE ON "box"
      FOR EACH ROW EXECUTE FUNCTION sync_box_network_policy()
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS box_network_policy_sync ON "box"`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS sync_box_network_policy()`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "outboundAllowNet"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "outboundMode"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "inboundMode"`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS box_allow_net_from_list(text)`)
  }
}
