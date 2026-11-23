import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerNestedCapabilities1794310000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "runner" ADD "nestedVirtualizationEnabled" boolean NOT NULL DEFAULT false')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "runner" DROP COLUMN "nestedVirtualizationEnabled"')
  }
}
