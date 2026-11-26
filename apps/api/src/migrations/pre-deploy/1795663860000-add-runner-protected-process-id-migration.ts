import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerProtectedProcessId1795663860000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "runner" ADD COLUMN "protectedProcessId" uuid, ADD COLUMN "protectedExecutableDigest" varchar(64)',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "runner" DROP COLUMN "protectedExecutableDigest", DROP COLUMN "protectedProcessId"',
    )
  }
}
