/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Follow-up to Migration1781016743403 (Sandbox → Box rename): that migration
 * renamed most sandbox-vocabulary objects to their box-vocabulary equivalents
 * but missed three pieces, leaving the schema inconsistent with the renamed
 * entities and enums:
 *
 *   runner.currentStartedSandboxes           → currentStartedBoxes
 *   organization.sandboxLimitedNetworkEgress → boxLimitedNetworkEgress
 *   job_resourcetype_enum SANDBOX value      → BOX
 *
 * Symptoms before this migration:
 *   - Any query that loads the Runner entity (ResourceManager,
 *     SnapshotManager.propagateSnapshotToRunners) errors with
 *     "column Runner.currentStartedBoxes does not exist".
 *   - Box create through the Box service errors with
 *     "column Organization.boxLimitedNetworkEgress does not exist"
 *     (box.service.ts reads organization.boxLimitedNetworkEgress).
 *   - The runner-job CREATE_BOX path errors with
 *     'invalid input value for enum job_resourcetype_enum: "BOX"' because
 *     the TS ResourceType enum was renamed (apps/api/src/box/enums/
 *     resource-type.enum.ts: BOX = 'BOX') but the Postgres enum type
 *     still only knows 'SANDBOX'.
 *
 * Guards: every step is wrapped in a DO block that checks current state, so
 * partial-state environments are safe to re-run and idempotent if anyone has
 * already hand-applied any of the three renames.
 */
export class Migration1781072797240 implements MigrationInterface {
  name = 'Migration1781072797240'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'runner' AND column_name = 'currentStartedSandboxes'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'runner' AND column_name = 'currentStartedBoxes'
        ) THEN
          ALTER TABLE "runner" RENAME COLUMN "currentStartedSandboxes" TO "currentStartedBoxes";
        END IF;
      END $$;
    `)

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'organization' AND column_name = 'sandboxLimitedNetworkEgress'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'organization' AND column_name = 'boxLimitedNetworkEgress'
        ) THEN
          ALTER TABLE "organization"
            RENAME COLUMN "sandboxLimitedNetworkEgress" TO "boxLimitedNetworkEgress";
        END IF;
      END $$;
    `)

    // ALTER TYPE ... RENAME VALUE is in-place and propagates to every row
    // referencing the enum (storage is by OID, label is what's renamed).
    // Requires Postgres 10+.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'job_resourcetype_enum')
            AND enumlabel = 'SANDBOX'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'job_resourcetype_enum')
            AND enumlabel = 'BOX'
        ) THEN
          ALTER TYPE "job_resourcetype_enum" RENAME VALUE 'SANDBOX' TO 'BOX';
        END IF;
      END $$;
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'job_resourcetype_enum')
            AND enumlabel = 'BOX'
        ) AND NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'job_resourcetype_enum')
            AND enumlabel = 'SANDBOX'
        ) THEN
          ALTER TYPE "job_resourcetype_enum" RENAME VALUE 'BOX' TO 'SANDBOX';
        END IF;
      END $$;
    `)
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "organization" RENAME COLUMN "boxLimitedNetworkEgress" TO "sandboxLimitedNetworkEgress"`,
    )
    await queryRunner.query(
      `ALTER TABLE IF EXISTS "runner" RENAME COLUMN "currentStartedBoxes" TO "currentStartedSandboxes"`,
    )
  }
}
