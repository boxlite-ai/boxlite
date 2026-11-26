import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOutboundProxyAdmission1795663861000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE outbound_proxy_admission (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      controlled boolean NOT NULL DEFAULT false,
      registry_writes boolean NOT NULL DEFAULT false,
      enabled boolean NOT NULL DEFAULT false,
      generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
      release_key text,
      pins jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(pins) = 'object'),
      standalone_update uuid,
      dev_acceptance_organization uuid,
      dev_acceptance_until timestamptz,
      dev_acceptance_commit varchar(40),
      restore_permit uuid,
      restore_runner uuid,
      restore_digest varchar(64),
      restore_generation bigint,
      CHECK (NOT enabled OR (controlled AND registry_writes AND restore_permit IS NULL)),
      CHECK (NOT controlled OR standalone_update IS NULL),
      CHECK ((dev_acceptance_organization IS NULL) = (dev_acceptance_until IS NULL)),
      CHECK ((dev_acceptance_organization IS NULL) = (dev_acceptance_commit IS NULL)),
      CHECK (dev_acceptance_organization IS NULL OR (controlled AND registry_writes AND NOT enabled AND restore_permit IS NULL)),
      CHECK ((restore_permit IS NULL) = (restore_runner IS NULL)),
      CHECK ((restore_permit IS NULL) = (restore_digest IS NULL)),
      CHECK ((restore_permit IS NULL) = (restore_generation IS NULL))
    )`)
    await runner.query('INSERT INTO outbound_proxy_admission DEFAULT VALUES')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE outbound_proxy_admission')
  }
}
