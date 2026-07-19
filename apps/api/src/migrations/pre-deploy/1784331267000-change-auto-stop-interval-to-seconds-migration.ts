import { MigrationInterface, QueryRunner } from 'typeorm'

export class ChangeAutoStopIntervalToSeconds1784331267000 implements MigrationInterface {
  name = 'ChangeAutoStopIntervalToSeconds1784331267000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing values were persisted as minutes. Convert them once before the
    // application starts interpreting the same column as seconds.
    await queryRunner.query(`UPDATE "box" SET "autoStopInterval" = "autoStopInterval" * 60`)
    await queryRunner.query(`ALTER TABLE "box" ALTER COLUMN "autoStopInterval" SET DEFAULT '900'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "box" SET "autoStopInterval" = "autoStopInterval" / 60`)
    await queryRunner.query(`ALTER TABLE "box" ALTER COLUMN "autoStopInterval" SET DEFAULT '15'`)
  }
}
