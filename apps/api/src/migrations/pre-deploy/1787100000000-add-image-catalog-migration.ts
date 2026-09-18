import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddImageCatalog1787100000000 implements MigrationInterface {
  name = 'AddImageCatalog1787100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "public"."image_version_state_enum" AS ENUM('ready', 'deleted')`)
    // Only one member today. The builder adds 'build' when it lands, which is
    // an ALTER TYPE rather than a rewrite.
    await queryRunner.query(`CREATE TYPE "public"."image_source_kind_enum" AS ENUM('pull')`)

    // One row per upstream repository an organization has pulled. There is no
    // organizationId IS NULL row for curated images: those stay env-driven so
    // that rotating one does not need a migration, and the catalog endpoint
    // unions them in at read time.
    await queryRunner.query(
      `CREATE TABLE "image" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "organizationId" uuid NOT NULL, "name" character varying(255) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastUsedAt" TIMESTAMP WITH TIME ZONE, "deletedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "image_id_pk" PRIMARY KEY ("id"))`,
    )
    // Partial, so a soft-deleted name can be used again. A table-level unique
    // constraint cannot express that, and the one Volume uses is why deleting
    // a volume and recreating it under the same name fails.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "image_org_name_active_unique" ON "image" ("organizationId", "name") WHERE "deletedAt" IS NULL`,
    )
    // Serves the per-org listing and the count the admission gate takes before
    // every cold pull.
    await queryRunner.query(`CREATE INDEX "image_org_lastused_index" ON "image" ("organizationId", "lastUsedAt")`)

    // `digest` is the OCI manifest digest the runner reports, not the host's
    // disk cache key. `sizeBytes` is bigint because a byte count should not be
    // bounded by int4.
    await queryRunner.query(
      `CREATE TABLE "image_version" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "imageId" uuid NOT NULL, "digest" character varying(71) NOT NULL, "sizeBytes" bigint NOT NULL, "state" "public"."image_version_state_enum" NOT NULL DEFAULT 'ready', "sourceKind" "public"."image_source_kind_enum" NOT NULL, "sourceSpec" jsonb NOT NULL, "storageRef" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "image_version_id_pk" PRIMARY KEY ("id"), CONSTRAINT "image_version_image_digest_unique" UNIQUE ("imageId", "digest"), CONSTRAINT "image_version_imageId_fk" FOREIGN KEY ("imageId") REFERENCES "image"("id") ON DELETE CASCADE ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(`CREATE INDEX "image_version_image_state_index" ON "image_version" ("imageId", "state")`)

    // RESTRICT on versionId, not CASCADE: a version a tag still names must not
    // disappear underneath it.
    await queryRunner.query(
      `CREATE TABLE "image_tag" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "imageId" uuid NOT NULL, "name" character varying(128) NOT NULL, "versionId" uuid NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "image_tag_id_pk" PRIMARY KEY ("id"), CONSTRAINT "image_tag_image_name_unique" UNIQUE ("imageId", "name"), CONSTRAINT "image_tag_imageId_fk" FOREIGN KEY ("imageId") REFERENCES "image"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "image_tag_versionId_fk" FOREIGN KEY ("versionId") REFERENCES "image_version"("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    )

    // A count rather than a byte budget: nothing central stores the bytes, and
    // what fills a shared runner's disk is the number of distinct images it
    // has to cache. Additive, so the running API simply ignores it.
    await queryRunner.query(`ALTER TABLE "organization" ADD "image_count_limit" integer NOT NULL DEFAULT 20`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "organization" DROP COLUMN "image_count_limit"`)
    await queryRunner.query(`DROP TABLE "image_tag"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."image_version_image_state_index"`)
    await queryRunner.query(`DROP TABLE "image_version"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."image_org_lastused_index"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."image_org_name_active_unique"`)
    await queryRunner.query(`DROP TABLE "image"`)
    await queryRunner.query(`DROP TYPE "public"."image_source_kind_enum"`)
    await queryRunner.query(`DROP TYPE "public"."image_version_state_enum"`)
  }
}
