import { MigrationInterface, QueryRunner } from 'typeorm'
import { APP_BOX_BACKFILL, APP_BOX_SYNC } from '../pre-deploy/1794500000000-add-app-box-ownership-migration'

export class DropAppBoxPointer1794500001000 implements MigrationInterface {
  name = 'DropAppBoxPointer1794500001000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(APP_BOX_BACKFILL)
    await queryRunner.query(`DROP TRIGGER app_box_owner ON cloud_app.envs;
      DROP FUNCTION cloud_app.sync_box_owner();
      ALTER TABLE cloud_app.envs DROP COLUMN box_id;`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE cloud_app.envs ADD COLUMN box_id text;
      UPDATE cloud_app.envs SET box_id = active_box_id;`)
    await queryRunner.query(APP_BOX_SYNC)
  }
}
