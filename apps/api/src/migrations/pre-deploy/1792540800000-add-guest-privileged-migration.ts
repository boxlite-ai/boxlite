import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddGuestPrivileged1792540800000 implements MigrationInterface {
  name = 'AddGuestPrivileged1792540800000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "privileged" boolean NOT NULL DEFAULT false`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "privileged"`)
  }
}
