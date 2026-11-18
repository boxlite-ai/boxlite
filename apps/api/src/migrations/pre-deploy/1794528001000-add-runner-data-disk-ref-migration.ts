import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerDataDiskRef1794528001000 implements MigrationInterface {
  name = 'AddRunnerDataDiskRef1794528001000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // NULL for every existing runner: runners report the disk identity in
    // their healthcheck, so the column fills as the fleet upgrades, and the
    // expansion controller skips runners without one.
    await queryRunner.query(`ALTER TABLE "runner" ADD "dataDiskRef" jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runner" DROP COLUMN "dataDiskRef"`)
  }
}
