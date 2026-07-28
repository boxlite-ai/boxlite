import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddOrgBoxImages1785143000000 implements MigrationInterface {
  name = 'AddOrgBoxImages1785143000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."org_box_image_status_enum" AS ENUM('active', 'blocked', 'deleted')`)
    await queryRunner.query(
      `CREATE TABLE "org_box_image" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "ref" character varying NOT NULL,
        "status" "public"."org_box_image_status_enum" NOT NULL DEFAULT 'active',
        "createdBy" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "org_box_image_organizationId_name_key" UNIQUE ("organizationId", "name"),
        CONSTRAINT "org_box_image_organizationId_ref_key" UNIQUE ("organizationId", "ref"),
        CONSTRAINT "org_box_image_pk" PRIMARY KEY ("id"),
        CONSTRAINT "org_box_image_organizationId_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    )
    await queryRunner.query(`CREATE INDEX "org_box_image_organizationid_idx" ON "org_box_image" ("organizationId")`)
    await queryRunner.query(`CREATE INDEX "org_box_image_status_idx" ON "org_box_image" ("status")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."org_box_image_status_idx"`)
    await queryRunner.query(`DROP INDEX "public"."org_box_image_organizationid_idx"`)
    await queryRunner.query(`DROP TABLE "org_box_image"`)
    await queryRunner.query(`DROP TYPE "public"."org_box_image_status_enum"`)
  }
}
