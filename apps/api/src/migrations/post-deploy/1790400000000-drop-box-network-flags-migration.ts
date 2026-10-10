import { MigrationInterface, QueryRunner } from 'typeorm'

// Contract half of replacing the network flags: once every API instance reads
// `inboundMode` / `outboundMode` / `outboundAllowNet`, the sync trigger and the
// flag columns it fed go. The split helper stays until the columns are gone.
export class DropBoxNetworkFlags1790400000000 implements MigrationInterface {
  name = 'DropBoxNetworkFlags1790400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER IF EXISTS box_network_policy_sync ON "box"`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS sync_box_network_policy()`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN IF EXISTS "public"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN IF EXISTS "networkBlockAll"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN IF EXISTS "networkAllowList"`)
    await queryRunner.query(`DROP FUNCTION IF EXISTS box_allow_net_from_list(text)`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Re-create the flag columns from the policy columns so the pre-deploy
    // migration's own down() can run after this one is reverted.
    await queryRunner.query(`ALTER TABLE "box" ADD "public" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "box" ADD "networkBlockAll" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "box" ADD "networkAllowList" character varying`)
    await queryRunner.query(`
      UPDATE "box" SET
        "public" = "inboundMode" = 'enabled',
        "networkBlockAll" = "outboundMode" = 'disabled',
        "networkAllowList" = array_to_string("outboundAllowNet", ',')
    `)
  }
}
