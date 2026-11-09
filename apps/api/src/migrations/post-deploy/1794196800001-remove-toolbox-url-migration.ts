import { MigrationInterface, QueryRunner } from 'typeorm'

export class RemoveToolboxUrl1794196800001 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE region DROP COLUMN "toolboxProxyUrl"')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE region ADD COLUMN "toolboxProxyUrl" character varying')
  }
}
