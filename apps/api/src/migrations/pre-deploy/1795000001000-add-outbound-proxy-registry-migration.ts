import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOutboundProxyRegistry1795000001000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE outbound_proxy_key (
        id text PRIMARY KEY,
        uses bigint NOT NULL DEFAULT 0 CHECK (uses BETWEEN 0 AND 4294967296),
        retired boolean NOT NULL DEFAULT false
      );
      CREATE TABLE outbound_proxy_key_selector (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        key_id text REFERENCES outbound_proxy_key
      );
      INSERT INTO outbound_proxy_key_selector DEFAULT VALUES;
      CREATE TABLE outbound_proxy_registration (
        organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        id uuid NOT NULL,
        name text NOT NULL,
        current_revision integer NOT NULL,
        rollout_pending boolean NOT NULL DEFAULT false,
        PRIMARY KEY (organization_id, id),
        CONSTRAINT outbound_proxy_org_name_unique UNIQUE (organization_id, name)
      );
      CREATE TABLE outbound_proxy_revision (
        organization_id uuid NOT NULL,
        registration_id uuid NOT NULL,
        revision integer NOT NULL CHECK (revision > 0),
        url text NOT NULL,
        envelope jsonb,
        key_id text GENERATED ALWAYS AS (envelope->>'keyId') STORED REFERENCES outbound_proxy_key,
        CHECK (envelope IS NULL OR key_id IS NOT NULL),
        PRIMARY KEY (organization_id, registration_id, revision),
        FOREIGN KEY (organization_id, registration_id)
          REFERENCES outbound_proxy_registration ON DELETE CASCADE
      );
      ALTER TABLE outbound_proxy_registration ADD CONSTRAINT outbound_proxy_current_fk
        FOREIGN KEY (organization_id, id, current_revision) REFERENCES outbound_proxy_revision
        DEFERRABLE INITIALLY DEFERRED;
      CREATE TABLE outbound_proxy_reference (
        organization_id uuid NOT NULL,
        box_id varchar NOT NULL,
        kind text NOT NULL CHECK (kind IN ('committed', 'pending')),
        registration_id uuid NOT NULL,
        revision integer NOT NULL,
        runner_id text NOT NULL,
        runtime_epoch text NOT NULL,
        attempt_id text NOT NULL,
        PRIMARY KEY (box_id, kind),
        FOREIGN KEY (organization_id, box_id) REFERENCES box ("organizationId", id) ON DELETE RESTRICT,
        CONSTRAINT outbound_proxy_revision_pinned_fk FOREIGN KEY (organization_id, registration_id, revision)
          REFERENCES outbound_proxy_revision ON DELETE RESTRICT
      );
      CREATE INDEX outbound_proxy_reference_revision_idx
        ON outbound_proxy_reference (organization_id, registration_id, revision);
      CREATE INDEX outbound_proxy_revision_key_idx ON outbound_proxy_revision (key_id);
    `)
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive) throw new Error('Revert the outbound proxy Registry in a transaction')
    await runner.query(`
      LOCK TABLE outbound_proxy_reference, outbound_proxy_revision, outbound_proxy_registration,
        outbound_proxy_key_selector, outbound_proxy_key IN ACCESS EXCLUSIVE MODE;
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM outbound_proxy_reference)
          OR EXISTS (SELECT 1 FROM outbound_proxy_revision)
          OR EXISTS (SELECT 1 FROM outbound_proxy_registration)
          OR EXISTS (SELECT 1 FROM outbound_proxy_key_selector WHERE key_id IS NOT NULL)
          OR EXISTS (SELECT 1 FROM outbound_proxy_key)
        THEN
          RAISE EXCEPTION 'Cannot revert a populated outbound proxy Registry' USING ERRCODE = '55000';
        END IF;
      END $$;
      DROP TABLE outbound_proxy_reference;
      ALTER TABLE outbound_proxy_registration DROP CONSTRAINT outbound_proxy_current_fk;
      DROP TABLE outbound_proxy_revision;
      DROP TABLE outbound_proxy_registration;
      DROP TABLE outbound_proxy_key_selector;
      DROP TABLE outbound_proxy_key;
    `)
  }
}
