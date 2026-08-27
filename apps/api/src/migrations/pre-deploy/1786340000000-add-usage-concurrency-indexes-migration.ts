import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddUsageConcurrencyIndexes1786340000000 implements MigrationInterface {
  name = 'AddUsageConcurrencyIndexes1786340000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_box_usage_periods_org_compute_start" ON "box_usage_periods" ("organizationId", "startAt") INCLUDE ("boxId", "endAt") WHERE "cpu" > 0`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_box_usage_periods_archive_org_compute_end" ON "box_usage_periods_archive" ("organizationId", "endAt") INCLUDE ("boxId", "startAt") WHERE "cpu" > 0`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_box_usage_periods_archive_org_compute_end"`)
    await queryRunner.query(`DROP INDEX "idx_box_usage_periods_org_compute_start"`)
  }
}
