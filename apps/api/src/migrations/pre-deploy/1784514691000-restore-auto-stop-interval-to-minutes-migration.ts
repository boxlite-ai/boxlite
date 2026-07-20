import { MigrationInterface, QueryRunner } from 'typeorm'

export class RestoreAutoStopIntervalToMinutes1784514691000 implements MigrationInterface {
  name = 'RestoreAutoStopIntervalToMinutes1784514691000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Reverse the previously deployed seconds conversion for existing rows.
    await queryRunner.query(`UPDATE "box" SET "autoStopInterval" = "autoStopInterval" / 60`)
    await queryRunner.query(`ALTER TABLE "box" ALTER COLUMN "autoStopInterval" SET DEFAULT '15'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "box" SET "autoStopInterval" = "autoStopInterval" * 60`)
    await queryRunner.query(`ALTER TABLE "box" ALTER COLUMN "autoStopInterval" SET DEFAULT '900'`)
  }
}
