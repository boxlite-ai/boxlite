import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxGpuType1784280000000 implements MigrationInterface {
  name = 'AddBoxGpuType1784280000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" ADD "gpu_type" character varying`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "gpu_type"`)
  }
}
