import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxLogCapture1762539090000 implements MigrationInterface {
  name = 'AddBoxLogCapture1762539090000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "captureLogs" boolean NOT NULL DEFAULT false`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "captureLogs"`)
  }
}
