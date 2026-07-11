/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782700400000 implements MigrationInterface {
  name = 'Migration1782700400000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentSetupAttemptId" character varying`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentSetupProviderReference" character varying`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentSetupNextReconcileAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentSetupReconcileAttempts" integer NOT NULL DEFAULT 0`)
    await queryRunner.query(`ALTER TABLE "wallet" ADD "paymentSetupLastError" text`)

    await queryRunner.query(`ALTER TABLE "top_up_record" ADD "reconcileAttempts" integer NOT NULL DEFAULT 0`)
    await queryRunner.query(`ALTER TABLE "top_up_record" ADD "nextReconcileAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "top_up_record" ADD "lastReconciledAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "top_up_record" ADD "reconcileLastError" text`)
    await queryRunner.query(`ALTER TABLE "top_up_record" ADD "refundedCents" bigint NOT NULL DEFAULT 0`)
    await queryRunner.query(`ALTER TABLE "top_up_record" ADD "disputedCents" bigint NOT NULL DEFAULT 0`)
    await queryRunner.query(
      `ALTER TABLE "top_up_record" ADD CONSTRAINT "top_up_record_reversal_non_negative"
       CHECK ("refundedCents" >= 0 AND "disputedCents" >= 0)`,
    )

    await queryRunner.query(`ALTER TABLE "payment_provider_event" ADD "providerReference" character varying`)
    await queryRunner.query(
      `ALTER TABLE "payment_provider_event" ADD "status" character varying NOT NULL DEFAULT 'processed'`,
    )
    await queryRunner.query(`ALTER TABLE "payment_provider_event" ADD "payload" jsonb`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" ADD "attempts" integer NOT NULL DEFAULT 1`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" ADD "nextAttemptAt" TIMESTAMP WITH TIME ZONE`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" ADD "lastError" text`)
    await queryRunner.query(
      `ALTER TABLE "payment_provider_event" ADD "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    )

    await queryRunner.query(`ALTER TABLE "wallet_transaction" ADD "providerActionId" character varying`)

    await queryRunner.query(`UPDATE "top_up_record" SET "nextReconcileAt" = "updatedAt" WHERE "status" = 'pending'`)

    await queryRunner.query(
      `CREATE INDEX "top_up_record_reconcile_due_idx"
       ON "top_up_record" ("nextReconcileAt")
       WHERE "status" = 'pending' AND "nextReconcileAt" IS NOT NULL`,
    )
    await queryRunner.query(
      `CREATE INDEX "wallet_payment_setup_reconcile_due_idx"
       ON "wallet" ("paymentSetupNextReconcileAt")
       WHERE "paymentSetupAttemptId" IS NOT NULL AND "paymentSetupNextReconcileAt" IS NOT NULL`,
    )
    await queryRunner.query(
      `CREATE INDEX "payment_provider_event_retry_due_idx"
       ON "payment_provider_event" ("nextAttemptAt")
       WHERE "status" = 'failed' AND "nextAttemptAt" IS NOT NULL`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallet_transaction_provider_action_idx"
       ON "wallet_transaction" ("providerActionId") WHERE "providerActionId" IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "wallet_transaction_provider_action_idx"`)
    await queryRunner.query(`DROP INDEX "payment_provider_event_retry_due_idx"`)
    await queryRunner.query(`DROP INDEX "wallet_payment_setup_reconcile_due_idx"`)
    await queryRunner.query(`DROP INDEX "top_up_record_reconcile_due_idx"`)

    await queryRunner.query(`ALTER TABLE "wallet_transaction" DROP COLUMN "providerActionId"`)

    await queryRunner.query(`ALTER TABLE "payment_provider_event" DROP COLUMN "updatedAt"`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" DROP COLUMN "lastError"`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" DROP COLUMN "nextAttemptAt"`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" DROP COLUMN "attempts"`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" DROP COLUMN "payload"`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" DROP COLUMN "status"`)
    await queryRunner.query(`ALTER TABLE "payment_provider_event" DROP COLUMN "providerReference"`)

    await queryRunner.query(`ALTER TABLE "top_up_record" DROP CONSTRAINT "top_up_record_reversal_non_negative"`)
    await queryRunner.query(`ALTER TABLE "top_up_record" DROP COLUMN "disputedCents"`)
    await queryRunner.query(`ALTER TABLE "top_up_record" DROP COLUMN "refundedCents"`)
    await queryRunner.query(`ALTER TABLE "top_up_record" DROP COLUMN "reconcileLastError"`)
    await queryRunner.query(`ALTER TABLE "top_up_record" DROP COLUMN "lastReconciledAt"`)
    await queryRunner.query(`ALTER TABLE "top_up_record" DROP COLUMN "nextReconcileAt"`)
    await queryRunner.query(`ALTER TABLE "top_up_record" DROP COLUMN "reconcileAttempts"`)

    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentSetupLastError"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentSetupReconcileAttempts"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentSetupNextReconcileAt"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentSetupProviderReference"`)
    await queryRunner.query(`ALTER TABLE "wallet" DROP COLUMN "paymentSetupAttemptId"`)
  }
}
