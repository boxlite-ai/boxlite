import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxNestedVirtualization1793808000000 implements MigrationInterface {
  name = 'AddBoxNestedVirtualization1793808000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "box" ADD "nestedVirtualization" boolean')
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Older workers cannot preserve this requirement after the column is gone.
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM "box" WHERE "nestedVirtualization" IS TRUE) THEN
        RAISE EXCEPTION 'Retire nested boxes and drain their jobs before rollback';
      END IF;
    END $$`)
    await queryRunner.query('ALTER TABLE "box" DROP COLUMN "nestedVirtualization"')
  }
}
