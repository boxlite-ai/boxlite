import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxUsageExportOutbox1786100000000 implements MigrationInterface {
  name = 'AddBoxUsageExportOutbox1786100000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "box_usage_export_outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "eventKey" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "schemaVersion" integer NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "availableAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "deliveredAt" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        "organizationId" character varying,
        "boxId" character varying,
        "startAt" TIMESTAMP WITH TIME ZONE,
        "endAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "box_usage_export_outbox_id_pk" PRIMARY KEY ("id"),
        CONSTRAINT "box_usage_export_outbox_event_key_uq" UNIQUE ("eventKey"),
        CONSTRAINT "box_usage_export_outbox_attempts_ck" CHECK ("attempts" >= 0),
        CONSTRAINT "box_usage_export_outbox_status_ck"
          CHECK ("status" IN ('pending', 'delivered', 'blocked'))
      )`,
    )
    // The publisher only ever scans claimable rows. A partial index keeps that
    // scan proportional to the backlog rather than to delivered history, which
    // retention prunes on its own schedule.
    await queryRunner.query(
      `CREATE INDEX "box_usage_export_outbox_pending_idx" ON "box_usage_export_outbox" ("status", "availableAt") WHERE "status" = 'pending'`,
    )
    // Retention deletes by age within a status; without this the sweep degrades
    // into a full scan once delivered rows accumulate.
    await queryRunner.query(
      `CREATE INDEX "box_usage_export_outbox_delivered_idx" ON "box_usage_export_outbox" ("deliveredAt") WHERE "status" = 'delivered'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "box_usage_export_outbox"`)
  }
}
