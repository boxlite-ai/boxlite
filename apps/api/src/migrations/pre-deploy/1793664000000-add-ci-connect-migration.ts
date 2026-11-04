/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCiConnect1793664000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE ci_installation_binding (
      id uuid PRIMARY KEY, github_host text NOT NULL, app_client_id text NOT NULL,
      installation_id bigint NOT NULL CHECK (installation_id > 0), account_id bigint NOT NULL CHECK (account_id > 0),
      account_login text NOT NULL, account_type text NOT NULL CHECK (account_type IN ('User','Organization')),
      organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE, actor_id text NOT NULL,
      follow_installation boolean NOT NULL CHECK (follow_installation), allow_public boolean NOT NULL,
      state text NOT NULL DEFAULT 'provisioning' CHECK (state IN ('provisioning','ready','disabled','failed')),
      generation bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (github_host, app_client_id, installation_id))`)
    await runner.query(`CREATE TABLE ci_connect_attempt (
      id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE, user_id text NOT NULL,
      github_account text NOT NULL, allow_public boolean NOT NULL, app_client_id text NOT NULL,
      device_ciphertext text NULL, state text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','polling','done','failed','cancelled','expired','installation_required')),
      expires_at timestamptz NOT NULL, next_poll_at timestamptz NOT NULL,
      interval_seconds integer NOT NULL CHECK (interval_seconds > 0),
      lease_id uuid NULL, lease_until timestamptz NULL,
      binding_id uuid NULL REFERENCES ci_installation_binding(id), created_at timestamptz NOT NULL DEFAULT now())`)
    await runner.query(
      'CREATE INDEX ci_connect_attempt_expiry_idx ON ci_connect_attempt (expires_at) WHERE device_ciphertext IS NOT NULL',
    )
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE ci_connect_attempt')
    await runner.query('DROP TABLE ci_installation_binding')
  }
}
