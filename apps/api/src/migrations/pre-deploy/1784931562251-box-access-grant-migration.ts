import { MigrationInterface, QueryRunner } from 'typeorm'

export class BoxAccessGrant1784931562251 implements MigrationInterface {
  name = 'BoxAccessGrant1784931562251'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."box_access_grant_scopes_enum" AS ENUM('ssh')`)
    await queryRunner.query(
      `CREATE TYPE "public"."box_access_grant_status_enum" AS ENUM('ACTIVE', 'REVOKING', 'REVOKED')`,
    )
    await queryRunner.query(
      `CREATE TABLE "box_access_grant" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "boxId" character varying NOT NULL, "secretDigest" text NOT NULL, "scopes" "public"."box_access_grant_scopes_enum" array NOT NULL, "status" "public"."box_access_grant_status_enum" NOT NULL DEFAULT 'ACTIVE', "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdBy" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "box_access_grant_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "box_access_grant_secretdigest_idx" ON "box_access_grant" ("secretDigest") `,
    )
    await queryRunner.query(
      `CREATE INDEX "box_access_grant_boxid_status_idx" ON "box_access_grant" ("boxId", "status") `,
    )
    await queryRunner.query(
      `CREATE TYPE "public"."temporary_ssh_credential_status_enum" AS ENUM('PENDING', 'ACTIVE', 'REVOKING', 'REVOKED')`,
    )
    await queryRunner.query(
      `CREATE TABLE "temporary_ssh_credential" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "grantId" uuid NOT NULL, "boxId" character varying NOT NULL, "publicKey" text NOT NULL, "publicKeyFingerprint" character varying NOT NULL, "unixUser" character varying NOT NULL DEFAULT 'root', "status" "public"."temporary_ssh_credential_status_enum" NOT NULL DEFAULT 'PENDING', "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdBy" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "temporary_ssh_credential_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "temporary_ssh_credential_active_dedup_idx" ON "temporary_ssh_credential" ("boxId", "publicKeyFingerprint", "unixUser") WHERE "status" <> 'REVOKED'`,
    )
    await queryRunner.query(
      `CREATE INDEX "temporary_ssh_credential_grantid_idx" ON "temporary_ssh_credential" ("grantId") `,
    )
    await queryRunner.query(
      `CREATE INDEX "temporary_ssh_credential_boxid_status_idx" ON "temporary_ssh_credential" ("boxId", "status") `,
    )
    await queryRunner.query(`CREATE TYPE "public"."box_ssh_identity_status_enum" AS ENUM('READY', 'DEGRADED')`)
    await queryRunner.query(
      `CREATE TABLE "box_ssh_identity" ("boxId" character varying NOT NULL, "algorithm" character varying NOT NULL DEFAULT 'ssh-ed25519', "publicKey" text NOT NULL, "fingerprint" character varying NOT NULL, "identityGeneration" integer NOT NULL DEFAULT '1', "firstSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL, "status" "public"."box_ssh_identity_status_enum" NOT NULL DEFAULT 'READY', CONSTRAINT "box_ssh_identity_boxId_pk" PRIMARY KEY ("boxId"))`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_access_grant" ADD CONSTRAINT "box_access_grant_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
    await queryRunner.query(
      `ALTER TABLE "temporary_ssh_credential" ADD CONSTRAINT "temporary_ssh_credential_grantId_fk" FOREIGN KEY ("grantId") REFERENCES "box_access_grant"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
    await queryRunner.query(
      `ALTER TABLE "temporary_ssh_credential" ADD CONSTRAINT "temporary_ssh_credential_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
    await queryRunner.query(
      `ALTER TABLE "box_ssh_identity" ADD CONSTRAINT "box_ssh_identity_boxId_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "box_ssh_identity" DROP CONSTRAINT "box_ssh_identity_boxId_fk"`)
    await queryRunner.query(
      `ALTER TABLE "temporary_ssh_credential" DROP CONSTRAINT "temporary_ssh_credential_boxId_fk"`,
    )
    await queryRunner.query(
      `ALTER TABLE "temporary_ssh_credential" DROP CONSTRAINT "temporary_ssh_credential_grantId_fk"`,
    )
    await queryRunner.query(`ALTER TABLE "box_access_grant" DROP CONSTRAINT "box_access_grant_boxId_fk"`)
    await queryRunner.query(`DROP TABLE "box_ssh_identity"`)
    await queryRunner.query(`DROP TYPE "public"."box_ssh_identity_status_enum"`)
    await queryRunner.query(`DROP INDEX "public"."temporary_ssh_credential_boxid_status_idx"`)
    await queryRunner.query(`DROP INDEX "public"."temporary_ssh_credential_grantid_idx"`)
    await queryRunner.query(`DROP INDEX "public"."temporary_ssh_credential_active_dedup_idx"`)
    await queryRunner.query(`DROP TABLE "temporary_ssh_credential"`)
    await queryRunner.query(`DROP TYPE "public"."temporary_ssh_credential_status_enum"`)
    await queryRunner.query(`DROP INDEX "public"."box_access_grant_boxid_status_idx"`)
    await queryRunner.query(`DROP INDEX "public"."box_access_grant_secretdigest_idx"`)
    await queryRunner.query(`DROP TABLE "box_access_grant"`)
    await queryRunner.query(`DROP TYPE "public"."box_access_grant_status_enum"`)
    await queryRunner.query(`DROP TYPE "public"."box_access_grant_scopes_enum"`)
  }
}
