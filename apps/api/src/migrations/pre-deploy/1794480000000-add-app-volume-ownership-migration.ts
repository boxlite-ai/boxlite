import { MigrationInterface, QueryRunner } from 'typeorm'

export const APP_VOLUME_BACKFILL = `
DO $$ BEGIN
  IF EXISTS (
    SELECT m.volume_id FROM cloud_app.env_volumes m JOIN volume v ON v.id::text = m.volume_id
    GROUP BY m.volume_id HAVING count(DISTINCT m.env_id) > 1
  ) THEN
    RAISE EXCEPTION 'A volume is recorded for multiple App environments';
  END IF;
  IF EXISTS (
    SELECT 1 FROM cloud_app.env_volumes m JOIN volume v ON v.id::text = m.volume_id
    JOIN cloud_app.envs e ON e.id = m.env_id JOIN cloud_app.apps a ON a.id = e.app_id
    WHERE v."organizationId" IS DISTINCT FROM a.org_id
  ) THEN
    RAISE EXCEPTION 'An App volume belongs to another organization';
  END IF;
END $$;
UPDATE volume v SET target_type = 'app', app_id = e.app_id, environment_id = e.id
FROM cloud_app.env_volumes m JOIN cloud_app.envs e ON e.id = m.env_id
WHERE v.id::text = m.volume_id;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM volume v JOIN box b ON b.volumes @> jsonb_build_array(jsonb_build_object('volumeId', v.id::text))
    WHERE v.target_type = 'app' AND b."desiredState" <> 'destroyed'
      AND (to_jsonb(b)->>'app_id') IS DISTINCT FROM v.app_id
      AND NOT EXISTS (SELECT 1 FROM cloud_app.envs e WHERE e.app_id = v.app_id AND e.box_id = b.id)
  ) THEN
    RAISE EXCEPTION 'Remove Box mounts outside the owning App before migrating volumes';
  END IF;
END $$;`

export const APP_VOLUME_SYNC = `
CREATE FUNCTION cloud_app.sync_volume_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE volume v SET target_type = 'app', app_id = e.app_id, environment_id = e.id
  FROM cloud_app.envs e JOIN cloud_app.apps a ON a.id = e.app_id
  WHERE e.id = NEW.env_id AND v.id::text = NEW.volume_id AND v."organizationId" = a.org_id
    AND (v.target_type = 'box' OR (v.app_id = e.app_id AND v.environment_id = e.id));
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Volume ownership conflicts with its App environment';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_volume_owner AFTER INSERT OR UPDATE ON cloud_app.env_volumes
FOR EACH ROW EXECUTE FUNCTION cloud_app.sync_volume_owner();`

export class AddAppVolumeOwnership1794480000000 implements MigrationInterface {
  name = 'AddAppVolumeOwnership1794480000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE volume
      ADD COLUMN target_type character varying NOT NULL DEFAULT 'box',
      ADD COLUMN app_id text,
      ADD COLUMN environment_id text;
      ALTER TABLE volume ADD CONSTRAINT volume_target CHECK (
        (target_type = 'box' AND app_id IS NULL AND environment_id IS NULL)
        OR (target_type = 'app' AND app_id IS NOT NULL AND environment_id IS NOT NULL
          AND app_id ~ '[^[:space:]]' AND environment_id ~ '[^[:space:]]')
      );
      CREATE INDEX volume_app_environment_idx ON volume (app_id, environment_id) WHERE target_type = 'app';`)
    await queryRunner.query(APP_VOLUME_BACKFILL)
    await queryRunner.query(APP_VOLUME_SYNC)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER app_volume_owner ON cloud_app.env_volumes;
      DROP FUNCTION cloud_app.sync_volume_owner();
      ALTER TABLE volume DROP CONSTRAINT volume_target;
      DROP INDEX volume_app_environment_idx;
      ALTER TABLE volume DROP COLUMN environment_id, DROP COLUMN app_id, DROP COLUMN target_type;`)
  }
}
