import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Expand-phase migration for CA-based real SSH. Purely additive: it creates the
 * certificate credential and organization CA metadata tables and leaves the
 * legacy `ssh_access` table untouched so the old API can keep running.
 */
export class AddSshCertificateCredential1785041441144 implements MigrationInterface {
  name = 'AddSshCertificateCredential1785041441144'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "organization_ssh_ca_key_status_enum" AS ENUM('current', 'next', 'retired')`,
    )
    await queryRunner.query(
      `CREATE TABLE "organization_ssh_ca_key" ("id" uuid NOT NULL, "organizationId" uuid NOT NULL, "keyId" text NOT NULL, "providerKeyRef" text NOT NULL, "publicKey" text NOT NULL, "status" "organization_ssh_ca_key_status_enum" NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "activatedAt" TIMESTAMP, "retiredAt" TIMESTAMP, CONSTRAINT "organization_ssh_ca_key_id_pk" PRIMARY KEY ("id"), CONSTRAINT "organization_ssh_ca_key_organizationId_keyId_unique" UNIQUE ("organizationId", "keyId"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "organization_ssh_ca_key_current_unique" ON "organization_ssh_ca_key" ("organizationId") WHERE "status" = 'current'`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "organization_ssh_ca_key_next_unique" ON "organization_ssh_ca_key" ("organizationId") WHERE "status" = 'next'`,
    )

    await queryRunner.query(
      `CREATE TABLE "ssh_certificate_credential" ("id" uuid NOT NULL, "boxId" character varying NOT NULL, "organizationId" uuid NOT NULL, "certificate" text NOT NULL, "publicKey" text NOT NULL, "fingerprint" text NOT NULL, "serial" bigint NOT NULL, "caKeyId" text NOT NULL, "validAfter" TIMESTAMP NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "revokedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "ssh_certificate_credential_id_pk" PRIMARY KEY ("id"), CONSTRAINT "ssh_certificate_credential_organizationId_serial_unique" UNIQUE ("organizationId", "serial"), CONSTRAINT "ssh_certificate_credential_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `CREATE INDEX "ssh_certificate_credential_boxId_id_index" ON "ssh_certificate_credential" ("boxId", "id")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ssh_certificate_credential_boxId_id_index"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "ssh_certificate_credential"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "organization_ssh_ca_key_next_unique"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "organization_ssh_ca_key_current_unique"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "organization_ssh_ca_key"`)
    await queryRunner.query(`DROP TYPE IF EXISTS "organization_ssh_ca_key_status_enum"`)
  }
}
