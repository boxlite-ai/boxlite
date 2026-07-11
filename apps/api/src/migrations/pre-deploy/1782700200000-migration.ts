/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class Migration1782700200000 implements MigrationInterface {
  name = 'Migration1782700200000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "wallet" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "organizationId" uuid NOT NULL,
        "freeBalanceCents" bigint NOT NULL DEFAULT 0,
        "paidBalanceCents" bigint NOT NULL DEFAULT 0,
        "settlementRemainderCents" numeric(38,18) NOT NULL DEFAULT 0,
        "freeExpiresAt" TIMESTAMP WITH TIME ZONE,
        "billingStatus" character varying NOT NULL DEFAULT 'trial',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "wallet_free_balance_non_negative" CHECK ("freeBalanceCents" >= 0),
        CONSTRAINT "wallet_remainder_range" CHECK (
          "settlementRemainderCents" >= 0 AND "settlementRemainderCents" < 1
        ),
        CONSTRAINT "wallet_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(`CREATE UNIQUE INDEX "wallet_organization_idx" ON "wallet" ("organizationId")`)

    await queryRunner.query(
      `CREATE TABLE "wallet_transaction" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "walletId" uuid NOT NULL,
        "organizationId" uuid NOT NULL,
        "kind" character varying NOT NULL,
        "amountCents" bigint NOT NULL,
        "source" character varying NOT NULL,
        "ratedPeriodId" uuid,
        "metadata" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "wallet_transaction_wallet_fk" FOREIGN KEY ("walletId")
          REFERENCES "wallet"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "wallet_transaction_rated_period_fk" FOREIGN KEY ("ratedPeriodId")
          REFERENCES "rated_period"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
        CONSTRAINT "wallet_transaction_id_pk" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(
      `CREATE INDEX "wallet_transaction_wallet_created_idx" ON "wallet_transaction" ("walletId", "createdAt")`,
    )
    await queryRunner.query(
      `CREATE INDEX "wallet_transaction_org_created_idx" ON "wallet_transaction" ("organizationId", "createdAt")`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallet_transaction_rated_period_idx" ON "wallet_transaction" ("ratedPeriodId")`,
    )
    await queryRunner.query(
      `CREATE FUNCTION "reject_wallet_transaction_mutation"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet transactions are immutable';
      END;
      $$ LANGUAGE plpgsql`,
    )
    await queryRunner.query(
      `CREATE TRIGGER "wallet_transaction_immutable"
      BEFORE UPDATE OR DELETE ON "wallet_transaction"
      FOR EACH ROW EXECUTE FUNCTION "reject_wallet_transaction_mutation"()`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "wallet_transaction"`)
    await queryRunner.query(`DROP TABLE "wallet"`)
    await queryRunner.query(`DROP FUNCTION "reject_wallet_transaction_mutation"()`)
  }
}
