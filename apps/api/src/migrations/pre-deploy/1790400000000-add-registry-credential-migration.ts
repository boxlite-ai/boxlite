import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRegistryCredential1790400000000 implements MigrationInterface {
  name = 'AddRegistryCredential1790400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "registry_credential_kind_enum" AS ENUM('basic')`)
    // No password column, by design: the password goes to Secret Manager and
    // `secretVersion` names where. A new table, so the running API ignores it.
    await queryRunner.query(
      `CREATE TABLE "registry_credential" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "organizationId" uuid NOT NULL, "kind" "registry_credential_kind_enum" NOT NULL, "registryHost" character varying(255) NOT NULL, "repositoryPrefix" character varying(255) NOT NULL DEFAULT '', "username" character varying(255) NOT NULL, "secretVersion" text NOT NULL, "createdBy" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "registry_credential_prefix_shape" CHECK ("repositoryPrefix" = '' OR ("repositoryPrefix" LIKE '%/' AND "repositoryPrefix" NOT LIKE '/%')), CONSTRAINT "registry_credential_id_pk" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "registry_credential_org_host_prefix_unique" ON "registry_credential" ("organizationId", "registryHost", "repositoryPrefix")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "registry_credential_org_host_prefix_unique"`)
    await queryRunner.query(`DROP TABLE "registry_credential"`)
    await queryRunner.query(`DROP TYPE "registry_credential_kind_enum"`)
  }
}
