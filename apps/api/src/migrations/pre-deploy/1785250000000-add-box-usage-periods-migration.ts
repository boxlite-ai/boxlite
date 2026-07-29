import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxUsagePeriods1785250000000 implements MigrationInterface {
  name = 'AddBoxUsagePeriods1785250000000'

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
        CONSTRAINT "box_usage_periods_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE INDEX "idx_box_usage_periods_box_end" ON "box_usage_periods" ("boxId", "endAt")`)
    // Enforces the at-most-one-open-period-per-box invariant that the advisory
    // Redis lock alone cannot guarantee; see box-usage-period.entity.ts.
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
        CONSTRAINT "box_usage_periods_archive_id_pk" PRIMARY KEY ("id")
      )`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "box_usage_periods_archive"`)
    await queryRunner.query(`DROP TABLE "box_usage_periods"`)
  }
}
