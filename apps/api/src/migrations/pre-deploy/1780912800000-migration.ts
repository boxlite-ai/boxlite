/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class DefaultOrganizationMembership1780912800000 implements MigrationInterface {
  name = 'DefaultOrganizationMembership1780912800000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "organization_user" ADD "isDefaultForUser" boolean NOT NULL DEFAULT false')
    await queryRunner.query(`
      UPDATE "organization_user" "ou"
      SET "isDefaultForUser" = true
      FROM "organization" "org"
      WHERE "ou"."organizationId" = "org"."id"
        AND "ou"."userId" = "org"."createdBy"
        AND "org"."personal" = true
    `)
    await queryRunner.query(`
      WITH ranked_memberships AS (
        SELECT
          "organizationId",
          "userId",
          ROW_NUMBER() OVER (
            PARTITION BY "userId"
            ORDER BY "createdAt" ASC, "organizationId" ASC
          ) AS rank
        FROM "organization_user" "ou"
        WHERE NOT EXISTS (
          SELECT 1
          FROM "organization_user" "default_ou"
          WHERE "default_ou"."userId" = "ou"."userId"
            AND "default_ou"."isDefaultForUser" = true
        )
      )
      UPDATE "organization_user" "ou"
      SET "isDefaultForUser" = true
      FROM ranked_memberships "ranked"
      WHERE "ou"."organizationId" = "ranked"."organizationId"
        AND "ou"."userId" = "ranked"."userId"
        AND "ranked"."rank" = 1
    `)
    await queryRunner.query(`
      UPDATE "organization"
      SET "name" = 'Default Organization'
      WHERE "personal" = true
        AND "name" = 'Personal'
    `)
    await queryRunner.query(
      'CREATE UNIQUE INDEX "organization_user_default_user_unique" ON "organization_user" ("userId") WHERE "isDefaultForUser" = true',
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "organization_user_default_user_unique"')
    await queryRunner.query('ALTER TABLE "organization_user" DROP COLUMN "isDefaultForUser"')
  }
}
