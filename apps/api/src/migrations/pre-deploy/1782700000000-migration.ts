import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782700000000 implements MigrationInterface {
  name = 'Migration1782700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "box_usage_period" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "boxId" character varying NOT NULL,
        "organizationId" character varying NOT NULL,
        "startAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "endAt" TIMESTAMP WITH TIME ZONE,
        "cpu" double precision NOT NULL,
        "gpu" double precision NOT NULL,
        "mem" double precision NOT NULL,
        "disk" double precision NOT NULL,
        "region" character varying NOT NULL,
        "boxClass" character varying NOT NULL DEFAULT 'small',
        "regionType" character varying NOT NULL DEFAULT 'shared',
        CONSTRAINT "box_usage_period_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE INDEX "box_usage_period_box_end_idx" ON "box_usage_period" ("boxId", "endAt")`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "box_usage_period_one_open_per_box_idx" ON "box_usage_period" ("boxId") WHERE "endAt" IS NULL`,
    )

    await queryRunner.query(
      `CREATE TABLE "box_usage_period_archive" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "boxId" character varying NOT NULL,
        "organizationId" character varying NOT NULL,
        "startAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "endAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "cpu" double precision NOT NULL,
        "gpu" double precision NOT NULL,
        "mem" double precision NOT NULL,
        "disk" double precision NOT NULL,
        "region" character varying NOT NULL,
        "boxClass" character varying NOT NULL DEFAULT 'small',
        "regionType" character varying NOT NULL DEFAULT 'shared',
        CONSTRAINT "box_usage_period_archive_id_pk" PRIMARY KEY ("id")
      )`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "box_usage_period_archive"`)
    await queryRunner.query(`DROP TABLE "box_usage_period"`)
  }
}
