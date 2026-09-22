/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBoxEndpoints1790076000000 implements MigrationInterface {
  name = 'AddBoxEndpoints1790076000000'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "box_endpoint" (
      "name" varchar(48) PRIMARY KEY,
      "organizationId" uuid NOT NULL,
      "boxId" varchar(12),
      "region" varchar NOT NULL,
      "port" integer NOT NULL,
      "url" varchar NOT NULL,
      "enabled" boolean NOT NULL DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "box_endpoint_name_check" CHECK ("name" ~ '^[a-z][a-z0-9-]{1,46}[a-z0-9]$'),
      CONSTRAINT "box_endpoint_port_check" CHECK ("port" BETWEEN 1 AND 65535 AND "port" <> 22222),
      CONSTRAINT "box_endpoint_box_fk" FOREIGN KEY ("boxId") REFERENCES "box"("id") ON DELETE SET NULL
    )`)
    await queryRunner.query(`CREATE INDEX "box_endpoint_organization_idx" ON "box_endpoint" ("organizationId")`)
    await queryRunner.query(`CREATE INDEX "box_endpoint_box_idx" ON "box_endpoint" ("boxId")`)
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "box_endpoint"`)
  }
}
