/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddMcpGrants1793116800001 implements MigrationInterface {
  name = 'AddMcpGrants1793116800001'
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE mcp_grant (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      client_id text NOT NULL,
      client_name text NOT NULL,
      resource text NOT NULL,
      scopes text[] NOT NULL,
      challenge_nonce uuid NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
      revoked_at timestamptz
    )`)
    await runner.query('CREATE INDEX mcp_grant_user ON mcp_grant (user_id, created_at)')
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE mcp_grant')
  }
}
