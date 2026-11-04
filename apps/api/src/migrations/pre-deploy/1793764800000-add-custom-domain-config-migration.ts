import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCustomDomainConfig1793764800000 implements MigrationInterface {
  name = 'AddCustomDomainConfig1793764800000'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE "custom_domain_subscription" (
        "organization_id" uuid PRIMARY KEY,
        "eligible" boolean,
        "valid_until" timestamptz NOT NULL DEFAULT '-infinity',
        "checked_at" timestamptz,
        "refresh_owner" uuid,
        "refresh_until" timestamptz NOT NULL DEFAULT '-infinity'
      )
    `)
    await runner.query(`
      CREATE TABLE "custom_domain_config" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "organization_id" uuid NOT NULL,
        "hostname" varchar(220) NOT NULL,
        "domain_id" uuid UNIQUE,
        "challenge" varchar(100) NOT NULL,
        "generation" integer NOT NULL DEFAULT 1,
        "challenge_expires_at" timestamptz NOT NULL,
        "dns_valid_until" timestamptz NOT NULL DEFAULT '-infinity',
        "certificate_valid_until" timestamptz NOT NULL DEFAULT '-infinity',
        "phase" varchar NOT NULL DEFAULT 'pending_verification',
        "error_code" varchar,
        "provider_state" jsonb NOT NULL DEFAULT '{}',
        "next_check_at" timestamptz NOT NULL DEFAULT now(),
        "attempts" integer NOT NULL DEFAULT 0,
        "lease_owner" uuid,
        "lease_until" timestamptz NOT NULL DEFAULT '-infinity',
        "deleted_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "custom_domain_config_phase" CHECK (
          "phase" IN ('pending_verification', 'pending_certificate_dns', 'provisioning', 'ready', 'deleting')
        )
      )
    `)
    // Deleted generations retain their cloud cleanup state without reserving a
    // hostname. A replacement uses a new UUID and distinct provider resources.
    await runner.query(`CREATE UNIQUE INDEX "custom_domain_config_live_name" ON "custom_domain_config"
      ("organization_id", "hostname") WHERE "deleted_at" IS NULL`)
    await runner.query(`CREATE INDEX "custom_domain_config_due" ON "custom_domain_config" ("next_check_at")`)
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP TABLE "custom_domain_config"`)
    await runner.query(`DROP TABLE "custom_domain_subscription"`)
  }
}
