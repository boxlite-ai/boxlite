import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxNestedVirtualization1793250000000 implements MigrationInterface {
  name = 'AddBoxNestedVirtualization1793250000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    // Existing Runner environments may have enabled nesting; do not backfill false.
    await queryRunner.query(`ALTER TABLE "box" ADD "nestedVirtualization" boolean`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box" DROP COLUMN "nestedVirtualization"`)
  }
}
