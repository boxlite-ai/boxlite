import { MigrationInterface, QueryRunner } from 'typeorm'
import {
  INITIALIZE_ORGANIZATION_ACTIVATION_FUNCTION,
  ORGANIZATION_ACTIVATION_BOX_TRIGGER,
  ORGANIZATION_ACTIVATION_INSERT_TRIGGER,
  RECORD_ORGANIZATION_BOX_ACTIVITY_FUNCTION,
} from '../pre-deploy/1792490000000-add-organization-activation-facts-migration'

// Contract half of the activation facts: once every API instance updates the facts
// itself after a Box write commits, the triggers that updated them inside the Box
// transaction go. Revert this before rolling the API back to a trigger-reliant
// revision.
export class DropOrganizationActivationTriggers1792510000000 implements MigrationInterface {
  name = 'DropOrganizationActivationTriggers1792510000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Activation migration requires a transaction')
    // DROP TRIGGER takes ACCESS EXCLUSIVE on its table, so Box reads and writes queue
    // behind it. Give up after five seconds; that fails a startup that runs migrations.
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`)
    await queryRunner.query(`DROP TRIGGER organization_activation_box_write ON box`)
    await queryRunner.query(`DROP TRIGGER organization_activation_insert ON organization`)
    await queryRunner.query(`DROP FUNCTION record_organization_box_activity()`)
    await queryRunner.query(`DROP FUNCTION initialize_organization_activation()`)
    await queryRunner.query(`SET LOCAL lock_timeout = DEFAULT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Activation migration requires a transaction')
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`)
    await queryRunner.query(INITIALIZE_ORGANIZATION_ACTIVATION_FUNCTION)
    await queryRunner.query(ORGANIZATION_ACTIVATION_INSERT_TRIGGER)
    await queryRunner.query(RECORD_ORGANIZATION_BOX_ACTIVITY_FUNCTION)
    await queryRunner.query(ORGANIZATION_ACTIVATION_BOX_TRIGGER)
    await queryRunner.query(`SET LOCAL lock_timeout = DEFAULT`)
  }
}
