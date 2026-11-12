import { MigrationInterface, QueryRunner } from 'typeorm'
import { APP_VOLUME_BACKFILL, APP_VOLUME_SYNC } from '../pre-deploy/1794480000000-add-app-volume-ownership-migration'

export class DropAppVolumeMappings1794480001000 implements MigrationInterface {
  name = 'DropAppVolumeMappings1794480001000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(APP_VOLUME_BACKFILL)
    await queryRunner.query(`DROP TRIGGER app_volume_owner ON cloud_app.env_volumes;
      DROP FUNCTION cloud_app.sync_volume_owner();
      DROP TABLE cloud_app.env_volumes;`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE cloud_app.env_volumes (
      env_id text NOT NULL REFERENCES cloud_app.envs(id) ON DELETE CASCADE,
      name text NOT NULL,
      volume_id text NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (env_id, name)
    );
    INSERT INTO cloud_app.env_volumes (env_id, name, volume_id, created_at)
    SELECT v.environment_id, v.name, v.id::text, v."createdAt"
    FROM volume v JOIN cloud_app.envs e ON e.id = v.environment_id AND e.app_id = v.app_id
    WHERE v.target_type = 'app';`)
    await queryRunner.query(APP_VOLUME_SYNC)
  }
}
