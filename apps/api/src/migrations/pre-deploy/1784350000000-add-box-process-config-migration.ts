import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxProcessConfig1784350000000 implements MigrationInterface {
  name = 'AddBoxProcessConfig1784350000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" ADD "entrypoint" jsonb')
    await queryRunner.query('ALTER TABLE "box" ADD "cmd" jsonb')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "cmd"')
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "entrypoint"')
  }
}
