import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddSignupCreditOutbox1786400000000 implements MigrationInterface {
  name = 'AddSignupCreditOutbox1786400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "signup_credit_outbox" (
      "eventKey" character varying NOT NULL,
      "organizationId" uuid NOT NULL,
      "payload" jsonb NOT NULL,
      "status" character varying(32) NOT NULL,
      "attempts" integer NOT NULL DEFAULT 0,
      "availableAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "eligibleAt" TIMESTAMP WITH TIME ZONE,
      "eligibilityKind" character varying(32),
      "deliveredAt" TIMESTAMP WITH TIME ZONE,
      "cancelledAt" TIMESTAMP WITH TIME ZONE,
      "lastError" text,
      "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "signup_credit_outbox_pk" PRIMARY KEY ("eventKey"),
      CONSTRAINT "signup_credit_outbox_organization_unique" UNIQUE ("organizationId"),
      CONSTRAINT "signup_credit_outbox_organization_fk" FOREIGN KEY ("organizationId")
        REFERENCES "organization"("id") ON DELETE CASCADE,
      CONSTRAINT "signup_credit_outbox_attempts_ck" CHECK ("attempts" >= 0),
      CONSTRAINT "signup_credit_outbox_status_ck" CHECK
        ("status" IN ('awaiting_verification', 'pending', 'delivered', 'blocked', 'cancelled')),
      CONSTRAINT "signup_credit_outbox_eligibility_kind_ck" CHECK
        ("eligibilityKind" IS NULL OR "eligibilityKind" IN ('registered_verified', 'verified_later'))
    )`)
    await queryRunner.query(
      `CREATE INDEX "signup_credit_outbox_pending_idx" ON "signup_credit_outbox" ("status", "availableAt") WHERE "status" = 'pending'`,
    )
    await queryRunner.query(
      `CREATE INDEX "signup_credit_outbox_delivered_idx" ON "signup_credit_outbox" ("deliveredAt") WHERE "status" = 'delivered'`,
    )
    await queryRunner.query(
      `CREATE INDEX "signup_credit_outbox_cancelled_idx" ON "signup_credit_outbox" ("cancelledAt") WHERE "status" = 'cancelled'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "signup_credit_outbox"`)
  }
}
