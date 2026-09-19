import { MigrationInterface, QueryRunner } from 'typeorm'

export class DropTemplateDeactivationTimeout1787200000000 implements MigrationInterface {
  name = 'DropTemplateDeactivationTimeout1787200000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "organization" DROP COLUMN IF EXISTS "template_deactivation_timeout_minutes"')
  }

  public down(): Promise<void> {
    // The column timed out unused templates for a subsystem that no longer
    // exists, so there is nothing for a rollback to put back: recreating it
    // would restore a default nothing reads.
    return Promise.resolve()
  }
}
