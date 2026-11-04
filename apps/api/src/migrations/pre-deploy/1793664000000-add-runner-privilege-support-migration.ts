import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerPrivilegeSupport1793664000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "runner" ADD "supportsPrivileged" boolean NOT NULL DEFAULT false')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "runner" DROP COLUMN "supportsPrivileged"')
  }
}
