import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxImageOwnership1787300000000 implements MigrationInterface {
  name = 'AddBoxImageOwnership1787300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Nullable with no default, and deliberately not backfilled. The value is
    // whether a box's image was the operator's curated set *at the moment that
    // box was created*, and the curated set is env-driven — a migration cannot
    // know what it held then, and writing today's answer onto old rows would
    // state a fact nobody checked. Null means "not recorded", and the reader
    // falls back to the recomputation those rows have always had.
    //
    // Pre-deploy: additive, so the API still running during the deploy window
    // neither reads nor writes it.
    await queryRunner.query(`ALTER TABLE "box" ADD "imageIsOrgOwned" boolean`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "imageIsOrgOwned"`)
  }
}
