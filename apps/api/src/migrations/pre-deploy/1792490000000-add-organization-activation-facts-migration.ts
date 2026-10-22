import { MigrationInterface, QueryRunner } from 'typeorm'

// The post-deploy migration that removes these triggers reinstalls them from
// the same statements when it is reverted.
export const INITIALIZE_ORGANIZATION_ACTIVATION_FUNCTION = `
      CREATE FUNCTION initialize_organization_activation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '00000000-0000-0000-0000-000000000000'::uuid THEN
          RETURN NULL;
        END IF;
        INSERT INTO organization_activation_facts ("organizationId", "boxHistoryComplete")
        VALUES (NEW.id, true);
        RETURN NULL;
      END
      $$
    `

export const ORGANIZATION_ACTIVATION_INSERT_TRIGGER = `
      CREATE TRIGGER organization_activation_insert AFTER INSERT ON organization
      FOR EACH ROW EXECUTE FUNCTION initialize_organization_activation()
    `

export const RECORD_ORGANIZATION_BOX_ACTIVITY_FUNCTION = `
      CREATE FUNCTION record_organization_box_activity() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        organization_id uuid;
        created_at timestamptz;
        modified_at timestamptz;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          organization_id := OLD."organizationId";
          -- Cleanup must not turn an earlier deletion into new activity.
          IF OLD."desiredState" = 'destroyed' OR OLD.state = 'destroyed' THEN
            RETURN NULL;
          END IF;
          modified_at := statement_timestamp();
        ELSE
          organization_id := NEW."organizationId";
          IF organization_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
            RETURN NULL;
          END IF;
          IF TG_OP = 'INSERT' THEN
            created_at := NEW."createdAt";
            IF NEW.state IN ('started', 'destroyed') OR NEW."desiredState" = 'destroyed' THEN
              modified_at := statement_timestamp();
            END IF;
          ELSIF OLD."organizationId" <> organization_id THEN
            IF OLD."organizationId" <> '00000000-0000-0000-0000-000000000000'::uuid THEN
              UPDATE organization_activation_facts SET "boxHistoryComplete" = false
              WHERE "organizationId" = organization_id AND "boxHistoryComplete";
              RETURN NULL;
            END IF;
            created_at := CASE WHEN OLD."createdAt" = NEW."createdAt"
              THEN statement_timestamp() ELSE NEW."createdAt" END;
            IF NEW.state IN ('started', 'destroyed') OR NEW."desiredState" = 'destroyed' THEN
              modified_at := statement_timestamp();
            END IF;
          ELSIF (NEW.state = 'started' AND OLD.state <> 'started')
             OR (NEW."desiredState" = 'destroyed' AND OLD."desiredState" <> 'destroyed')
             OR (NEW.state = 'destroyed' AND OLD.state <> 'destroyed' AND OLD."desiredState" <> 'destroyed') THEN
            modified_at := statement_timestamp();
          ELSE
            RETURN NULL;
          END IF;
        END IF;
        UPDATE organization_activation_facts
        SET "lastBoxCreatedAt" = GREATEST("lastBoxCreatedAt", created_at),
            "lastBoxModifiedAt" = GREATEST("lastBoxModifiedAt", modified_at)
        WHERE "organizationId" = organization_id AND (
          (created_at IS NOT NULL AND ("lastBoxCreatedAt" IS NULL OR "lastBoxCreatedAt" < created_at)) OR
          (modified_at IS NOT NULL AND ("lastBoxModifiedAt" IS NULL OR "lastBoxModifiedAt" < modified_at))
        );
        RETURN NULL;
      END
      $$
    `

export const ORGANIZATION_ACTIVATION_BOX_TRIGGER = `
      CREATE TRIGGER organization_activation_box_write
      AFTER INSERT OR UPDATE OF "organizationId", state, "desiredState" OR DELETE ON box
      FOR EACH ROW EXECUTE FUNCTION record_organization_box_activity()
    `

export class AddOrganizationActivationFacts1792490000000 implements MigrationInterface {
  name = 'AddOrganizationActivationFacts1792490000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Activation migration requires a transaction')
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`)
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`)
    await queryRunner.query(`
      CREATE TABLE organization_activation_facts (
        "organizationId" uuid PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
        "lastBoxCreatedAt" timestamptz,
        "lastBoxModifiedAt" timestamptz,
        "boxHistoryComplete" boolean NOT NULL
      )
    `)
    await queryRunner.query(INITIALIZE_ORGANIZATION_ACTIVATION_FUNCTION)
    await queryRunner.query(ORGANIZATION_ACTIVATION_INSERT_TRIGGER)
    await queryRunner.query(`
      INSERT INTO organization_activation_facts ("organizationId", "boxHistoryComplete")
      SELECT id, false FROM organization WHERE id <> '00000000-0000-0000-0000-000000000000'::uuid
    `)
    await queryRunner.query(RECORD_ORGANIZATION_BOX_ACTIVITY_FUNCTION)
    await queryRunner.query(ORGANIZATION_ACTIVATION_BOX_TRIGGER)
    await queryRunner.query(`
      UPDATE organization_activation_facts facts
      SET "lastBoxCreatedAt" = retained.last_created
      FROM (
        SELECT "organizationId", max("createdAt") AS last_created FROM box GROUP BY "organizationId"
      ) retained
      WHERE facts."organizationId" = retained."organizationId"
    `)
    await queryRunner.query(`SET LOCAL lock_timeout = DEFAULT`)
    await queryRunner.query(`SET LOCAL statement_timeout = DEFAULT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER organization_activation_box_write ON box`)
    await queryRunner.query(`DROP TRIGGER organization_activation_insert ON organization`)
    await queryRunner.query(`DROP FUNCTION record_organization_box_activity()`)
    await queryRunner.query(`DROP FUNCTION initialize_organization_activation()`)
    await queryRunner.query(`DROP TABLE organization_activation_facts`)
  }
}
