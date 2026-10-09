import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddImageTagEvent1790600000000 implements MigrationInterface {
  name = 'AddImageTagEvent1790600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // A new table, so the running API ignores it until the code that writes it
    // is deployed. The version references restrict and `createdAt` defaults to
    // `clock_timestamp()`, for the reasons the entity gives.
    await queryRunner.query(
      `CREATE TABLE "image_tag_event" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "imageId" uuid NOT NULL, "tagName" character varying(128) NOT NULL, "fromVersionId" uuid, "toVersionId" uuid NOT NULL, "actorId" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(), CONSTRAINT "image_tag_event_id_pk" PRIMARY KEY ("id"), CONSTRAINT "image_tag_event_imageId_fk" FOREIGN KEY ("imageId") REFERENCES "image"("id") ON DELETE CASCADE ON UPDATE NO ACTION, CONSTRAINT "image_tag_event_fromVersionId_fk" FOREIGN KEY ("fromVersionId") REFERENCES "image_version"("id") ON DELETE RESTRICT ON UPDATE NO ACTION, CONSTRAINT "image_tag_event_toVersionId_fk" FOREIGN KEY ("toVersionId") REFERENCES "image_version"("id") ON DELETE RESTRICT ON UPDATE NO ACTION)`,
    )
    await queryRunner.query(
      `CREATE INDEX "image_tag_event_image_created_index" ON "image_tag_event" ("imageId", "createdAt")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "image_tag_event_image_created_index"`)
    await queryRunner.query(`DROP TABLE "image_tag_event"`)
  }
}
