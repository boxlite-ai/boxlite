import { MigrationInterface, QueryRunner } from 'typeorm'

// Expand half of replacing the Daytona-era network flags (`public`,
// `networkBlockAll`, `networkAllowList`) with per-direction policy columns
// (`inboundEnabled`, `outboundEnabled`, `outboundAllowNet`). Outbound flips
// polarity and the allowlist changes type, so this is add-backfill-sync rather
// than a column rename. The trigger keeps both shapes equal while old and new
// API instances overlap; the post-deploy migration drops it with the old columns.
export class ReplaceBoxNetworkFlags1791000000000 implements MigrationInterface {
  name = 'ReplaceBoxNetworkFlags1791000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "inboundEnabled" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "box" ADD "outboundEnabled" boolean NOT NULL DEFAULT true`)
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
        "inboundEnabled" = "public",
        "outboundEnabled" = NOT "networkBlockAll",
        "outboundAllowNet" = box_allow_net_from_list("networkAllowList")
    `)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION sync_box_network_policy()
      RETURNS TRIGGER AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."inboundEnabled" IS DISTINCT FROM OLD."inboundEnabled" THEN
            NEW."public" := NEW."inboundEnabled";
          ELSIF NEW."public" IS DISTINCT FROM OLD."public" THEN
            NEW."inboundEnabled" := NEW."public";
          END IF;
          IF NEW."outboundEnabled" IS DISTINCT FROM OLD."outboundEnabled" THEN
            NEW."networkBlockAll" := NOT NEW."outboundEnabled";
          ELSIF NEW."networkBlockAll" IS DISTINCT FROM OLD."networkBlockAll" THEN
            NEW."outboundEnabled" := NOT NEW."networkBlockAll";
          END IF;
          IF NEW."outboundAllowNet" IS DISTINCT FROM OLD."outboundAllowNet" THEN
            NEW."networkAllowList" := array_to_string(NEW."outboundAllowNet", ',');
          ELSIF NEW."networkAllowList" IS DISTINCT FROM OLD."networkAllowList" THEN
            NEW."outboundAllowNet" := box_allow_net_from_list(NEW."networkAllowList");
          END IF;
        ELSE
          -- INSERT: whichever shape the writer filled in carries the value;
          -- the other still holds its column default.
          NEW."public" := NEW."public" OR NEW."inboundEnabled";
          NEW."inboundEnabled" := NEW."public";
          NEW."networkBlockAll" := NEW."networkBlockAll" OR NOT NEW."outboundEnabled";
          NEW."outboundEnabled" := NOT NEW."networkBlockAll";
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
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "outboundEnabled"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "inboundEnabled"`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS box_allow_net_from_list(text)`)
  }
}
