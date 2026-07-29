import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxUsagePeriods1784270000000 implements MigrationInterface {
  name = 'AddBoxUsagePeriods1784270000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "box_usage_periods" (
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
        CONSTRAINT "box_usage_periods_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE INDEX "idx_box_usage_periods_box_end" ON "box_usage_periods" ("boxId", "endAt")`)
    // At most one open period per box; the archiver only ever moves closed periods,
    // so the partial index stays small even as history grows.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "box_usage_periods_one_open_period_per_box_idx" ON "box_usage_periods" ("boxId") WHERE "endAt" IS NULL`,
    )

    await queryRunner.query(
      `CREATE TABLE "box_usage_periods_archive" (
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
        CONSTRAINT "box_usage_periods_archive_id_pk" PRIMARY KEY ("id")
      )`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "box_usage_periods_archive"`)
    await queryRunner.query(`DROP INDEX "public"."box_usage_periods_one_open_period_per_box_idx"`)
    await queryRunner.query(`DROP INDEX "public"."idx_box_usage_periods_box_end"`)
    await queryRunner.query(`DROP TABLE "box_usage_periods"`)
  }
}
