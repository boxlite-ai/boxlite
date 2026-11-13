import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerDiskPerformanceUpdated1794528004000 implements MigrationInterface {
  name = 'AddRunnerDiskPerformanceUpdated1794528004000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Marks whether a PATCH carried provisioned-performance fields, so the
    // performance cooldown gate can be answered with one (runnerId,
    // requestedAt) query instead of reconstructing which historical attempts
    // carried fields. GCP budgets provisioned-performance changes once per
    // 4h per disk, and a rejected attempt also starts that cooldown, so the
    // gate reads the marker regardless of the row's terminal status.
    await queryRunner.query(
      `ALTER TABLE "runner_disk_expansion" ADD "performanceUpdated" boolean NOT NULL DEFAULT false`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runner_disk_expansion" DROP COLUMN "performanceUpdated"`)
  }
}
