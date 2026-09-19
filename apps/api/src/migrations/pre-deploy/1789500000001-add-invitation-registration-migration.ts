import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddInvitationRegistration1789500000001 implements MigrationInterface {
  name = 'AddInvitationRegistration1789500000001'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE "user_registration" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      "userId" varchar NOT NULL,
      "defaultOrganizationId" uuid,
      "inviterOrganizationId" uuid,
      "referredCode" varchar(10),
      "status" varchar(24) NOT NULL,
      "eventId" uuid,
      "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "acceptedAt" timestamptz,
      CONSTRAINT "user_registration_user_id_uq" UNIQUE ("userId"),
      CONSTRAINT "user_registration_event_id_uq" UNIQUE ("eventId"),
      CONSTRAINT "user_registration_status_ck" CHECK ("status" IN ('none', 'pending_verification', 'accepted')),
      CONSTRAINT "user_registration_attribution_ck" CHECK (
        ("status" = 'none' AND "inviterOrganizationId" IS NULL AND "referredCode" IS NULL) OR
        ("status" <> 'none' AND "inviterOrganizationId" IS NOT NULL AND "referredCode" IS NOT NULL)),
      CONSTRAINT "user_registration_acceptance_ck" CHECK (
        ("status" = 'accepted' AND "acceptedAt" IS NOT NULL AND "eventId" IS NOT NULL) OR
        ("status" <> 'accepted' AND "acceptedAt" IS NULL AND "eventId" IS NULL))
    )`)
    await runner.query(`CREATE TABLE "organization_business_event_outbox" (
      "eventId" uuid PRIMARY KEY,
      "organizationId" uuid NOT NULL,
      "payload" jsonb NOT NULL,
      "status" varchar(16) NOT NULL DEFAULT 'pending',
      "attempts" integer NOT NULL DEFAULT 0,
      "availableAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deliveredAt" timestamptz,
      "lastError" text,
      "claimToken" uuid,
      "responseSnapshot" jsonb,
      CONSTRAINT "business_event_outbox_attempts_ck" CHECK ("attempts" >= 0),
      CONSTRAINT "business_event_outbox_status_ck" CHECK ("status" IN ('pending', 'delivered', 'blocked'))
    )`)
    await runner.query(`CREATE INDEX "business_event_outbox_pending_idx"
      ON "organization_business_event_outbox" ("status", "availableAt") WHERE "status" = 'pending'`)
    await runner.query(`INSERT INTO "user_registration" ("userId", "defaultOrganizationId", "status", "createdAt")
      SELECT existing.id, membership."organizationId", 'none', existing."createdAt"
      FROM "user" existing LEFT JOIN "organization_user" membership
        ON membership."userId" = existing.id AND membership."isDefaultForUser" = true`)
  }

  async down(runner: QueryRunner): Promise<void> {
    // Schema rollback is only safe before the feature has produced any durable facts.
    await runner.query(`LOCK TABLE "user_registration", "organization_business_event_outbox" IN ACCESS EXCLUSIVE MODE`)
    const [usage] = await runner.query(`SELECT
      EXISTS (SELECT 1 FROM "user_registration") OR
      EXISTS (SELECT 1 FROM "organization_business_event_outbox") AS used`)
    if (usage.used) throw new Error('Invitation data exists; roll back the application and retain the schema')
    await runner.query('DROP TABLE "organization_business_event_outbox"')
    await runner.query('DROP TABLE "user_registration"')
  }
}
