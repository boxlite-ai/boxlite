import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxLifecycleSeconds1784250000000 implements MigrationInterface {
  name = 'AddBoxLifecycleSeconds1784250000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" RENAME COLUMN "autoStopInterval" TO "autoPause"`)
    await queryRunner.query(`ALTER TABLE "box" RENAME COLUMN "autoDeleteInterval" TO "autoDelete"`)
    await queryRunner.query(
      `UPDATE "box" SET "autoPause" = CASE WHEN "autoPause" > 0 THEN "autoPause" * 60 ELSE 0 END, "autoDelete" = CASE WHEN "autoDelete" > 0 THEN "autoDelete" * 60 ELSE 0 END`,
    )
    await queryRunner.query(`ALTER TABLE "box" ALTER COLUMN "autoPause" SET DEFAULT 900`)
    await queryRunner.query(`ALTER TABLE "box" ALTER COLUMN "autoDelete" SET DEFAULT 0`)
    await queryRunner.query(`ALTER TABLE "box" ADD "autoResume" boolean NOT NULL DEFAULT true`)
    await queryRunner.query(
      `ALTER TABLE "box" ADD CONSTRAINT "box_auto_pause_interval_nonnegative" CHECK ("autoPause" >= 0)`,
    )
    await queryRunner.query(
      `ALTER TABLE "box" ADD CONSTRAINT "box_auto_delete_interval_nonnegative" CHECK ("autoDelete" >= 0)`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP CONSTRAINT IF EXISTS "box_auto_delete_interval_nonnegative"`)
    await queryRunner.query(`ALTER TABLE "box" DROP CONSTRAINT IF EXISTS "box_auto_pause_interval_nonnegative"`)
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "autoResume"`)
    await queryRunner.query(
      `UPDATE "box" SET "autoPause" = CASE WHEN "autoPause" > 0 THEN CEIL("autoPause" / 60.0)::integer ELSE 0 END, "autoDelete" = CASE WHEN "autoDelete" > 0 THEN CEIL("autoDelete" / 60.0)::integer ELSE -1 END`,
    )
    await queryRunner.query(`ALTER TABLE "box" ALTER COLUMN "autoPause" SET DEFAULT 15`)
    await queryRunner.query(`ALTER TABLE "box" ALTER COLUMN "autoDelete" SET DEFAULT -1`)
    await queryRunner.query(`ALTER TABLE "box" RENAME COLUMN "autoPause" TO "autoStopInterval"`)
    await queryRunner.query(`ALTER TABLE "box" RENAME COLUMN "autoDelete" TO "autoDeleteInterval"`)
  }
}
