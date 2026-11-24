import { MigrationInterface, QueryRunner } from 'typeorm'

export class TrackLegacyBuildSource1795507200000 implements MigrationInterface {
  name = 'TrackLegacyBuildSource1795507200000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE cloud_app.deployments ADD COLUMN legacy_source text')
    await queryRunner.query(`
      UPDATE cloud_app.deployments d SET legacy_source = 'read'
      FROM cloud_app.envs e
      WHERE d.env_id = e.id AND d.number = e.requested_deployment
        AND d.number IS DISTINCT FROM e.live_deployment AND d.kind = 'deploy'
        AND d.box_id = e.active_box_id AND d.status IN ('building', 'migrating', 'starting')
    `)
    await queryRunner.query(`
      CREATE INDEX cloud_app_legacy_build_source_idx ON cloud_app.deployments (env_id, box_id)
      WHERE legacy_source = 'read'
    `)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE cloud_app.deployments DROP COLUMN legacy_source')
  }
}
