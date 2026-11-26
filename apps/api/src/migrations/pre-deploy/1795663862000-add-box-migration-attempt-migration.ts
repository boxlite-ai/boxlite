import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxMigrationAttempt1795663862000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE box_migration ADD COLUMN "attemptId" uuid')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE box_migration DROP COLUMN "attemptId"')
  }
}
