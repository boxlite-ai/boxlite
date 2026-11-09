import { MigrationInterface, QueryRunner } from 'typeorm'

export class RemoveToolboxUrl1794196800001 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Run only after old API instances stop querying the retired entity column.
    await runner.query('ALTER TABLE region DROP COLUMN "toolboxProxyUrl"')
  }

  async down(runner: QueryRunner): Promise<void> {
    // Restores the old schema, not historical values. Old code falls back to its proxy URL config.
    await runner.query('ALTER TABLE region ADD COLUMN "toolboxProxyUrl" character varying')
  }
}
