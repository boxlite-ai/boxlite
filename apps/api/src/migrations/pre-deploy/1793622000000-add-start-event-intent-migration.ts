import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddStartEventIntent1793622000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" ADD "startEventPending" boolean NOT NULL DEFAULT false')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "startEventPending"')
  }
}
