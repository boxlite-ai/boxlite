import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationActivationFacts1792490000000 implements MigrationInterface {
  name = 'AddOrganizationActivationFacts1792490000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!queryRunner.isTransactionActive) throw new Error('Activation migration requires a transaction')
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`)
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`)
    await queryRunner.query(`
      CREATE TABLE organization_activation_facts (
        "organizationId" uuid PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
        "firstObservedBoxCreatedAt" timestamptz,
        "boxHistoryComplete" boolean NOT NULL,
        "firstRecordedComputeAt" timestamptz
      )
    `)
    await queryRunner.query(`
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
    `)
    await queryRunner.query(`
      CREATE TRIGGER organization_activation_insert AFTER INSERT ON organization
      FOR EACH ROW EXECUTE FUNCTION initialize_organization_activation()
    `)
    await queryRunner.query(`
      INSERT INTO organization_activation_facts ("organizationId", "boxHistoryComplete")
      SELECT id, false FROM organization WHERE id <> '00000000-0000-0000-0000-000000000000'::uuid
    `)
    await queryRunner.query(`
      CREATE FUNCTION record_organization_box_creation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        created_at timestamptz := NEW."createdAt";
      BEGIN
        IF NEW."organizationId" = '00000000-0000-0000-0000-000000000000'::uuid THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF OLD."organizationId" = NEW."organizationId" THEN
            RETURN NULL;
          END IF;
          IF OLD."organizationId" <> '00000000-0000-0000-0000-000000000000'::uuid THEN
            UPDATE organization_activation_facts SET "boxHistoryComplete" = false
            WHERE "organizationId" = NEW."organizationId" AND "boxHistoryComplete";
            RETURN NULL;
          END IF;
          IF OLD."createdAt" = NEW."createdAt" THEN
            created_at := statement_timestamp();
          END IF;
        END IF;
        UPDATE organization_activation_facts
        SET "firstObservedBoxCreatedAt" = created_at
        WHERE "organizationId" = NEW."organizationId"
          AND ("firstObservedBoxCreatedAt" IS NULL OR "firstObservedBoxCreatedAt" > created_at);
        RETURN NULL;
      END
      $$
    `)
    await queryRunner.query(`
      CREATE TRIGGER organization_activation_box_insert AFTER INSERT ON box
      FOR EACH ROW EXECUTE FUNCTION record_organization_box_creation()
    `)
    await queryRunner.query(`
      CREATE TRIGGER organization_activation_box_claim AFTER UPDATE OF "organizationId" ON box
      FOR EACH ROW EXECUTE FUNCTION record_organization_box_creation()
    `)
    await queryRunner.query(`
      CREATE FUNCTION record_organization_compute() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."organizationId" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
          RETURN NULL;
        END IF;
        UPDATE organization_activation_facts
        SET "firstRecordedComputeAt" = NEW."startAt"
        WHERE "organizationId" = NEW."organizationId"::uuid
          AND ("firstRecordedComputeAt" IS NULL OR "firstRecordedComputeAt" > NEW."startAt");
        RETURN NULL;
      END
      $$
    `)
    await queryRunner.query(`
      CREATE TRIGGER organization_activation_compute AFTER INSERT ON box_usage_periods
      FOR EACH ROW WHEN (NEW.cpu > 0 AND NEW.cpu < 'Infinity'::double precision)
      EXECUTE FUNCTION record_organization_compute()
    `)
    await queryRunner.query(`
      UPDATE organization_activation_facts facts
      SET "firstObservedBoxCreatedAt" = retained.first_created
      FROM (
        SELECT "organizationId", min("createdAt") AS first_created FROM box GROUP BY "organizationId"
      ) retained
      WHERE facts."organizationId" = retained."organizationId"
    `)
    await queryRunner.query(`
      UPDATE organization_activation_facts facts
      SET "firstRecordedComputeAt" = retained.first_compute
      FROM (
        SELECT "organizationId", min("startAt") AS first_compute
        FROM (
          SELECT "organizationId", "startAt" FROM box_usage_periods
          WHERE cpu > 0 AND cpu < 'Infinity'::double precision
          UNION ALL
          SELECT "organizationId", "startAt" FROM box_usage_periods_archive
          WHERE cpu > 0 AND cpu < 'Infinity'::double precision
        ) periods GROUP BY "organizationId"
      ) retained
      WHERE facts."organizationId"::text = retained."organizationId"
    `)
    await queryRunner.query(`SET LOCAL lock_timeout = DEFAULT`)
    await queryRunner.query(`SET LOCAL statement_timeout = DEFAULT`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER organization_activation_compute ON box_usage_periods`)
    await queryRunner.query(`DROP TRIGGER organization_activation_box_claim ON box`)
    await queryRunner.query(`DROP TRIGGER organization_activation_box_insert ON box`)
    await queryRunner.query(`DROP TRIGGER organization_activation_insert ON organization`)
    await queryRunner.query(`DROP FUNCTION record_organization_compute()`)
    await queryRunner.query(`DROP FUNCTION record_organization_box_creation()`)
    await queryRunner.query(`DROP FUNCTION initialize_organization_activation()`)
    await queryRunner.query(`DROP TABLE organization_activation_facts`)
  }
}
