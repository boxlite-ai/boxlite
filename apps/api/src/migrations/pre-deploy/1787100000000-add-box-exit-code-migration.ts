import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxExitCode1787100000000 implements MigrationInterface {
  name = 'AddBoxExitCode1787100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "exitCode" integer`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "exitCode"`)
  }
}
