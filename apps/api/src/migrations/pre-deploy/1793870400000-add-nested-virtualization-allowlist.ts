import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddNestedVirtualizationAllowlist1793870400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "organization" ADD "nestedVirtualizationEnabled" boolean NOT NULL DEFAULT false',
    )
    await queryRunner.query('ALTER TABLE "box" ADD "nestedVirtualization" boolean NOT NULL DEFAULT false')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const [nested] = await queryRunner.query(
      'SELECT EXISTS (SELECT 1 FROM "box" WHERE "nestedVirtualization") AS present',
    )
    if (nested.present) throw new Error('Retire nested boxes before removing their saved configuration')
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "nestedVirtualization"')
    await queryRunner.query('ALTER TABLE "organization" DROP COLUMN "nestedVirtualizationEnabled"')
  }
}
