import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddAdminUsageWindowIndexes1792470000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX idx_usage_live_end_start
      ON box_usage_periods ("endAt", "startAt")`)
    await queryRunner.query(`CREATE INDEX idx_usage_archive_end_start
      ON box_usage_periods_archive ("endAt", "startAt")`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX idx_usage_archive_end_start`)
    await queryRunner.query(`DROP INDEX idx_usage_live_end_start`)
  }
}
