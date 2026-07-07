import { MigrationInterface, QueryRunner } from 'typeorm'

export class WarmPoolSchedule1783425318065 implements MigrationInterface {
  name = 'WarmPoolSchedule1783425318065'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warm_pool" ADD "scheduleConfig" jsonb`)
    await queryRunner.query(`ALTER TABLE "warm_pool" ADD "timezone" character varying NOT NULL DEFAULT 'UTC'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "warm_pool" DROP COLUMN "timezone"`)
    await queryRunner.query(`ALTER TABLE "warm_pool" DROP COLUMN "scheduleConfig"`)
  }
}
