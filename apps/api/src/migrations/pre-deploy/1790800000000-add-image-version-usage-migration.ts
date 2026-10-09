import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddImageVersionUsage1790800000000 implements MigrationInterface {
  name = 'AddImageVersionUsage1790800000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Nullable and without a default, so the rows already there say "not
    // recorded yet" rather than a time nobody observed. The running API ignores
    // both columns until the code that writes them is deployed.
    await queryRunner.query(`ALTER TABLE "image_version" ADD "lastUsedAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "image_version" ADD "upstreamMissingAt" TIMESTAMP WITH TIME ZONE`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "image_version" DROP COLUMN "upstreamMissingAt"`)
    await queryRunner.query(`ALTER TABLE "image_version" DROP COLUMN "lastUsedAt"`)
  }
}
