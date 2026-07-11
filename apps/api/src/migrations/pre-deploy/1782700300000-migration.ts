/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782700300000 implements MigrationInterface {
  name = 'Migration1782700300000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentProviderCustomerId" character varying`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentProviderMethodId" character varying`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentMethodBrand" character varying`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentMethodLast4" character varying`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "autoReloadEnabled" boolean NOT NULL DEFAULT false`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "autoReloadThresholdCents" bigint`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "autoReloadTargetCents" bigint`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "autoReloadNextAttemptAt" TIMESTAMP WITH TIME ZONE`)

    await queryRunner.query(
      `CREATE TABLE "top_up_record" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "walletId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "amountCents" bigint NOT NULL,
        "source" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "idempotencyKey" character varying NOT NULL,
        "providerReference" character varying,
        "checkoutUrl" text,
        "receiptUrl" text,
        "failureCode" character varying,
        "failureMessage" text,
        "completedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "top_up_record_positive_amount" CHECK ("amountCents" > 0),
        CONSTRAINT "top_up_record_wallet_fk" FOREIGN KEY ("walletId")
          REFERENCES "wallet"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "top_up_record_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(
      `CREATE INDEX "top_up_record_org_created_idx" ON "top_up_record" ("organizationId", "createdAt")`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "top_up_record_org_idempotency_idx"
       ON "top_up_record" ("organizationId", "idempotencyKey")`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "top_up_record_provider_reference_idx"
       ON "top_up_record" ("providerReference") WHERE "providerReference" IS NOT NULL`,
    )

    await queryRunner.query(
      `CREATE TABLE "payment_provider_event" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "providerEventId" character varying NOT NULL,
        "eventType" character varying NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "payment_provider_event_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "payment_provider_event_provider_id_idx"
       ON "payment_provider_event" ("providerEventId")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "payment_provider_event"`)
    await queryRunner.query(`DROP TABLE "top_up_record"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "autoReloadNextAttemptAt"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "autoReloadTargetCents"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "autoReloadThresholdCents"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "autoReloadEnabled"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentMethodLast4"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentMethodBrand"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentProviderMethodId"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentProviderCustomerId"`)
  }
}
