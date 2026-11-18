import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddNestedVirtualizationAllowlist1793870400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "organization" ADD "nestedVirtualizationEnabled" boolean NOT NULL DEFAULT false',
    )
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "organization" DROP COLUMN "nestedVirtualizationEnabled"')
  }
}
