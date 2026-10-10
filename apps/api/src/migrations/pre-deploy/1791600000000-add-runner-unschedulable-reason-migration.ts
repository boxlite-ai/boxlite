import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerUnschedulableReason1791600000000 implements MigrationInterface {
  name = 'AddRunnerUnschedulableReason1791600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."runner_unschedulablereason_enum" AS ENUM('operator', 'disk_pressure')`,
    )
    await queryRunner.query(`ALTER TABLE "runner" ADD "unschedulableReason" "public"."runner_unschedulablereason_enum"`)
    // Every existing mark was set through the scheduling endpoints.
    await queryRunner.query(`UPDATE "runner" SET "unschedulableReason" = 'operator' WHERE "unschedulable" = true`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "unschedulableReason"`)
    await queryRunner.query(`DROP TYPE "public"."runner_unschedulablereason_enum"`)
  }
}
