/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { postgresStateTable } from '@boxlite-ai/ci-listener'

export class AddCiListenerState1793700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(postgresStateTable)
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE ci_listener_state')
  }
}
