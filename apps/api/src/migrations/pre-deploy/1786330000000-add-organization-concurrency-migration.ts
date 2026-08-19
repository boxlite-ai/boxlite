import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrganizationConcurrency1786330000000 implements MigrationInterface {
  name = 'AddOrganizationConcurrency1786330000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization_quota" ALTER COLUMN "max_concurrent_boxes" DROP NOT NULL`)
    await queryRunner.query(
      `CREATE TABLE "organization_concurrency_sample" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "runningBoxes" integer NOT NULL,
        "observedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "organization_concurrency_sample_pk" PRIMARY KEY ("id"),
        CONSTRAINT "organization_concurrency_sample_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    )
    await queryRunner.query(
      `CREATE INDEX "IDX_organization_concurrency_sample_org_observed" ON "organization_concurrency_sample" ("organizationId", "observedAt")`,
    )
    await queryRunner.query(
      `INSERT INTO "organization_concurrency_sample" ("organizationId", "runningBoxes")
       SELECT o."id", COUNT(b."id")::integer
       FROM "organization" o
       LEFT JOIN "box" b
         ON b."organizationId" = o."id"
        AND b."state" IN ('creating', 'restoring', 'starting', 'started', 'stopping', 'unknown')
       GROUP BY o."id"`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "organization_concurrency_sample"`)
    await queryRunner.query(
      `UPDATE "organization_quota" SET "max_concurrent_boxes" = 50 WHERE "max_concurrent_boxes" IS NULL`,
    )
    await queryRunner.query(`ALTER TABLE "organization_quota" ALTER COLUMN "max_concurrent_boxes" SET NOT NULL`)
  }
}
