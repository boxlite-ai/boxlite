import { MigrationInterface, QueryRunner } from 'typeorm'

// Disk I/O rate limits (`disk_io` on the REST create surface) are enforced by
// the runner through the box's cgroup, so they have to travel with the box:
// a stop/start that recreates it on another runner must throttle it the same
// way the caller asked for at create. Nullable: absent means unlimited.
export class AddBoxDiskIoLimits1787100000000 implements MigrationInterface {
  name = 'AddBoxDiskIoLimits1787100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "diskIo" jsonb`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "diskIo"`)
  }
}
