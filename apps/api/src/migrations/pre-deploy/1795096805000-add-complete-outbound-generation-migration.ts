import { MigrationInterface, QueryRunner } from 'typeorm'
import { assertCompleteOutboundDrained } from '../complete-outbound-schema'

export class AddCompleteOutboundGeneration1795096805000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "box" ADD "completeOutboundGeneration" integer NOT NULL DEFAULT 0')
  }

  async down(runner: QueryRunner): Promise<void> {
    await assertCompleteOutboundDrained(runner, true)
    await runner.query('ALTER TABLE "box" DROP COLUMN "completeOutboundGeneration"')
  }
}
