import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddJobCompletionRevision1795663863000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE job ADD COLUMN "completionRevision" varchar')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE job DROP COLUMN "completionRevision"')
  }
}
