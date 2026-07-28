import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationQuota1784260000000 implements MigrationInterface {
  name = 'AddOrganizationQuota1784260000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "organization_quota" (
        "organizationId" uuid NOT NULL,
        "total_cpu_quota" integer NOT NULL DEFAULT '64',
        "total_memory_quota" integer NOT NULL DEFAULT '256',
        "total_disk_quota" integer NOT NULL DEFAULT '512',
        "total_gpu_quota" integer NOT NULL DEFAULT '0',
        "max_concurrent_boxes" integer NOT NULL DEFAULT '50',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "organization_quota_pk" PRIMARY KEY ("organizationId"),
        CONSTRAINT "organization_quota_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    )
    // Backfill one default-quota row per existing organization so every org has an
    // editable row; new orgs without a row fall back to the same defaults in code.
    await queryRunner.query(`INSERT INTO "organization_quota" ("organizationId") SELECT "id" FROM "organization"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "organization_quota"`)
  }
}
