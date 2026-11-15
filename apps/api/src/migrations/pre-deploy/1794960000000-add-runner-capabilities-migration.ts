import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerCapabilities1794960000000 implements MigrationInterface {
  name = 'AddRunnerCapabilities1794960000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NULL for every existing runner: runners declare their capabilities in
    // the healthcheck, so the column fills as the fleet upgrades, and
    // dispatch treats a runner without the declaration as incapable.
    await queryRunner.query(`ALTER TABLE "runner" ADD "capabilities" jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "capabilities"`)
  }
}
