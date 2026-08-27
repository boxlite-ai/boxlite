import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxSecrets1787000000000 implements MigrationInterface {
  name = 'AddBoxSecrets1787000000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "secrets" jsonb NOT NULL DEFAULT '[]'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "secrets"`)
  }
}
