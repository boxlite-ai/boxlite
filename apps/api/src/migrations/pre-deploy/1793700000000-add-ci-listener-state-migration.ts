/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { postgresStateTable } from '@boxlite-ai/ci-listener'

export class AddCiListenerState1793700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(postgresStateTable)
  }
  async down(runner: QueryRunner): Promise<void> {
    // One statement keeps the check and drop atomic even without an outer transaction.
    await runner.query(`DO $$ BEGIN
      LOCK TABLE ci_listener_state IN ACCESS EXCLUSIVE MODE;
      IF EXISTS (SELECT 1 FROM ci_listener_state) THEN
        RAISE EXCEPTION 'CI Listener state must be empty before rollback';
      END IF;
      DROP TABLE ci_listener_state;
    END $$`)
  }
}
