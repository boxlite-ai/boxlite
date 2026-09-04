import { MigrationInterface, QueryRunner } from 'typeorm'

export class UpdateOrganizationPerBoxDefaults1782899417425 implements MigrationInterface {
  name = 'UpdateOrganizationPerBoxDefaults1782899417425'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization" ALTER COLUMN "max_cpu_per_box" SET DEFAULT '4', ALTER COLUMN "max_memory_per_box" SET DEFAULT '32', ALTER COLUMN "max_disk_per_box" SET DEFAULT '120'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organization" ALTER COLUMN "max_cpu_per_box" SET DEFAULT '4', ALTER COLUMN "max_memory_per_box" SET DEFAULT '8', ALTER COLUMN "max_disk_per_box" SET DEFAULT '10'`,
    )
  }
}
