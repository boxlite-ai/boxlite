import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerCpuIncidents1793232000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "runner_cpu_incident" (
      "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "runnerId" uuid NOT NULL,
      "eventId" uuid NOT NULL,
      "highCpuSince" timestamptz NOT NULL,
      "windowStartedAt" timestamptz NOT NULL,
      "windowEndedAt" timestamptz NOT NULL,
      "runnerCpuPercent" double precision NOT NULL CHECK ("runnerCpuPercent" > 80 AND "runnerCpuPercent" <= 100),
      "boxId" varchar(128),
      "image" text,
      "cpuSeconds" double precision NOT NULL CHECK ("cpuSeconds" >= 0 AND "cpuSeconds" <= 1e12),
      "samplingComplete" boolean NOT NULL,
      "receivedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "runner_cpu_incident_event_unique" UNIQUE ("runnerId", "eventId"),
      CHECK ("windowStartedAt" >= "highCpuSince" + interval '5 minutes'),
      CHECK ("windowEndedAt" >= "windowStartedAt" + interval '2 minutes'),
      CHECK (("boxId" IS NULL AND "cpuSeconds" = 0) OR ("boxId" IS NOT NULL AND "cpuSeconds" > 0)),
      CHECK ("boxId" IS NOT NULL OR "image" IS NULL)
    )`)
    await queryRunner.query(
      'CREATE INDEX "runner_cpu_incident_runner_id_idx" ON "runner_cpu_incident" ("runnerId", "id")',
    )
    await queryRunner.query(
      'CREATE INDEX "runner_cpu_incident_window_ended_at_idx" ON "runner_cpu_incident" ("windowEndedAt")',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "runner_cpu_incident"')
  }
}
