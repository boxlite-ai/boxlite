import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerDiskExpansion1794528002000 implements MigrationInterface {
  name = 'AddRunnerDiskExpansion1794528002000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."runner_disk_expansion_status_enum" AS ENUM('pending', 'confirmed', 'failed')`,
    )
    // One row per expansion attempt: `pending` from the moment GCP accepts the
    // resize until the runner's filesystem reports the new size (or the
    // attempt times out as `unconfirmed`). Failed-before-accept rows keep
    // accepted=false so they never consume the GCP-side resize budget that
    // only counts accepted requests. The rate-limit window and the 400
    // cooldown query by (runnerId, requestedAt).
    await queryRunner.query(`CREATE TABLE "runner_disk_expansion" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "runnerId" uuid NOT NULL,
      "fromGiB" double precision NOT NULL,
      "toGiB" double precision NOT NULL,
      "accepted" boolean NOT NULL,
      "operation" text,
      "status" "public"."runner_disk_expansion_status_enum" NOT NULL,
      "error" text,
      "requestedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
      "confirmedAt" TIMESTAMP WITH TIME ZONE,
      CONSTRAINT "runner_disk_expansion_id_pk" PRIMARY KEY ("id"),
      CONSTRAINT "runner_disk_expansion_runnerId_fk" FOREIGN KEY ("runnerId") REFERENCES "runner"("id") ON DELETE CASCADE ON UPDATE NO ACTION
    )`)
    await queryRunner.query(
      `CREATE INDEX "runner_disk_expansion_runnerId_requestedAt_idx" ON "runner_disk_expansion" ("runnerId", "requestedAt")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "runner_disk_expansion"`)
    await queryRunner.query(`DROP TYPE "public"."runner_disk_expansion_status_enum"`)
  }
}
