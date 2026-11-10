import { MigrationInterface, QueryRunner } from 'typeorm'

export class RemoveToolboxUrl1794400000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Startup discovers this directory too; ship only after all old readers have retired.
    await runner.query('ALTER TABLE region DROP COLUMN "toolboxProxyUrl"')
  }

  async down(runner: QueryRunner): Promise<void> {
    // Restores schema only. Removed URL values and pre-compatibility rollback are not recoverable here.
    await runner.query('ALTER TABLE region ADD COLUMN "toolboxProxyUrl" character varying')
  }
}
