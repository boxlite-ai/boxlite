import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782700000000 implements MigrationInterface {
  name = 'Migration1782700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "usage_period" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "boxId" character varying NOT NULL,
        "organizationId" character varying NOT NULL,
        "region" character varying,
        "startAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "endAt" TIMESTAMP WITH TIME ZONE,
        "kind" character varying NOT NULL,
        "cpu" double precision NOT NULL,
        "gpu" double precision NOT NULL,
        "mem" double precision NOT NULL,
        "disk" double precision NOT NULL,
        "actualCpuSeconds" double precision,
        "actualRssAvgBytes" bigint,
        "actualRssPeakBytes" bigint,
        "sampleCount" integer,
        CONSTRAINT "usage_period_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "usage_period_end_after_start" CHECK ("endAt" IS NULL OR "endAt" >= "startAt")
      )`,
    )
    await queryRunner.query(`CREATE INDEX "usage_period_box_end_idx" ON "usage_period" ("boxId", "endAt")`)
    await queryRunner.query(`CREATE INDEX "usage_period_org_start_idx" ON "usage_period" ("organizationId", "startAt")`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "usage_period_one_open_per_box_idx" ON "usage_period" ("boxId") WHERE "endAt" IS NULL`,
    )

    await queryRunner.query(
      `CREATE TABLE "usage_period_archive" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sourcePeriodId" uuid NOT NULL,
        "boxId" character varying NOT NULL,
        "organizationId" character varying NOT NULL,
        "region" character varying,
        "startAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "endAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "kind" character varying NOT NULL,
        "cpu" double precision NOT NULL,
        "gpu" double precision NOT NULL,
        "mem" double precision NOT NULL,
        "disk" double precision NOT NULL,
        "actualCpuSeconds" double precision,
        "actualRssAvgBytes" bigint,
        "actualRssPeakBytes" bigint,
        "sampleCount" integer,
        CONSTRAINT "usage_period_archive_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "usage_period_archive_end_after_start" CHECK ("endAt" >= "startAt")
      )`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "usage_period_archive_source_period_idx" ON "usage_period_archive" ("sourcePeriodId")`,
    )
    await queryRunner.query(
      `CREATE INDEX "usage_period_archive_org_start_idx" ON "usage_period_archive" ("organizationId", "startAt")`,
    )
    await queryRunner.query(
      `CREATE INDEX "usage_period_archive_box_start_idx" ON "usage_period_archive" ("boxId", "startAt")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "usage_period_archive"`)
    await queryRunner.query(`DROP TABLE "usage_period"`)
  }
}
