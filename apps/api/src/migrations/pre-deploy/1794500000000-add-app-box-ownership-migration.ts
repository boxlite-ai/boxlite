import { MigrationInterface, QueryRunner } from 'typeorm'

const APP_BOX_REFERENCES = `
  SELECT e.box_id, e.id AS environment_id, e.app_id, a.org_id
  FROM cloud_app.envs e JOIN cloud_app.apps a ON a.id = e.app_id
  UNION
  SELECT d.box_id, e.id AS environment_id, e.app_id, a.org_id
  FROM cloud_app.deployments d JOIN cloud_app.envs e ON e.id = d.env_id
  JOIN cloud_app.apps a ON a.id = e.app_id`

export const APP_BOX_BACKFILL = `
DO $$ BEGIN
  IF EXISTS (
    SELECT b.id FROM (${APP_BOX_REFERENCES}) r JOIN box b ON b.id = r.box_id
    GROUP BY b.id HAVING count(DISTINCT r.environment_id) > 1
  ) THEN
    RAISE EXCEPTION 'A Box is recorded for multiple App environments';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (${APP_BOX_REFERENCES}) r JOIN box b ON b.id = r.box_id
    WHERE b."organizationId" IS DISTINCT FROM r.org_id
      OR (b.app_id IS NOT NULL AND (b.app_id <> r.app_id OR b.environment_id <> r.environment_id))
  ) THEN
    RAISE EXCEPTION 'An App Box belongs to another organization or App environment';
  END IF;
END $$;
UPDATE box b SET app_id = r.app_id, environment_id = r.environment_id
FROM (${APP_BOX_REFERENCES}) r WHERE b.id = r.box_id;`

export const APP_BOX_SYNC = `
CREATE FUNCTION cloud_app.sync_box_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.active_box_id := COALESCE(NEW.active_box_id, NEW.box_id);
  ELSIF NEW.box_id IS DISTINCT FROM OLD.box_id AND NEW.active_box_id IS NOT DISTINCT FROM OLD.active_box_id THEN
    NEW.active_box_id := NEW.box_id;
  END IF;
  NEW.box_id := NEW.active_box_id;
  IF EXISTS (
    SELECT 1 FROM box b JOIN cloud_app.apps a ON a.id = NEW.app_id
    WHERE b.id = NEW.active_box_id AND (b."organizationId" IS DISTINCT FROM a.org_id
      OR (b.app_id IS NOT NULL AND (b.app_id <> NEW.app_id OR b.environment_id <> NEW.id)))
  ) THEN
    RAISE EXCEPTION 'The active Box belongs to another organization or App environment';
  END IF;
  UPDATE box SET app_id = NEW.app_id, environment_id = NEW.id WHERE id = NEW.active_box_id;
  RETURN NEW;
END $$;
CREATE TRIGGER app_box_owner BEFORE INSERT OR UPDATE OF box_id, active_box_id, app_id
ON cloud_app.envs FOR EACH ROW EXECUTE FUNCTION cloud_app.sync_box_owner();`

export class AddAppBoxOwnership1794500000000 implements MigrationInterface {
  name = 'AddAppBoxOwnership1794500000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE box ADD COLUMN app_id text, ADD COLUMN environment_id text;
      ALTER TABLE box ADD CONSTRAINT box_app_owner CHECK (
        (app_id IS NULL AND environment_id IS NULL) OR (app_id IS NOT NULL AND environment_id IS NOT NULL)
      );
      CREATE INDEX box_app_environment_idx ON box ("organizationId", app_id, environment_id);
      ALTER TABLE cloud_app.envs ADD COLUMN active_box_id text;
      UPDATE cloud_app.envs SET active_box_id = box_id;`)
    await queryRunner.query(APP_BOX_BACKFILL)
    await queryRunner.query(APP_BOX_SYNC)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER app_box_owner ON cloud_app.envs;
      DROP FUNCTION cloud_app.sync_box_owner();
      ALTER TABLE cloud_app.envs DROP COLUMN active_box_id;
      DROP INDEX box_app_environment_idx;
      ALTER TABLE box DROP CONSTRAINT box_app_owner, DROP COLUMN environment_id, DROP COLUMN app_id;`)
  }
}
