import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddJobStateChangeLockOwner1795628000000 implements MigrationInterface {
  name = 'AddJobStateChangeLockOwner1795628000000'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "job" ADD COLUMN "stateChangeLockOwner" uuid')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "job" DROP COLUMN "stateChangeLockOwner"')
  }
}
