import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunnerMemoryIncidents1793836800000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "runner_memory_incident" (
      "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "runnerId" uuid NOT NULL,
      "eventId" uuid NOT NULL,
      "sampledAt" timestamptz NOT NULL,
      "runnerMemoryPercent" double precision NOT NULL CHECK ("runnerMemoryPercent" > 80 AND "runnerMemoryPercent" <= 100),
      "boxes" jsonb NOT NULL CHECK (jsonb_typeof("boxes") = 'array' AND jsonb_array_length("boxes") <= 5),
      "samplingComplete" boolean NOT NULL,
      "receivedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "runner_memory_incident_event_unique" UNIQUE ("runnerId", "eventId")
    )`)
    await queryRunner.query(
      'CREATE INDEX "runner_memory_incident_runner_id_idx" ON "runner_memory_incident" ("runnerId", "id")',
    )
    await queryRunner.query(
      'CREATE INDEX "runner_memory_incident_sampled_at_idx" ON "runner_memory_incident" ("sampledAt")',
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "runner_memory_incident"')
  }
}
