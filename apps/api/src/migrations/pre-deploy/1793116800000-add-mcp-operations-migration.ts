import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddMcpOperations1793116800000 implements MigrationInterface {
  name = 'AddMcpOperations1793116800000'

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE mcp_operation (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      creator_id text NOT NULL,
      tool text NOT NULL CHECK (tool IN ('create_box', 'exec_box')),
      request_id uuid NOT NULL,
      input_hash text NOT NULL,
      identity jsonb NOT NULL,
      payload text,
      state text NOT NULL DEFAULT 'queued',
      process_state text NOT NULL DEFAULT 'not_started',
      collection_state text NOT NULL DEFAULT 'waiting',
      box_id text,
      execution_id text,
      exit_code integer,
      error_code text,
      lease_owner uuid,
      lease_epoch integer NOT NULL DEFAULT 0,
      lease_until timestamptz,
      completed_at timestamptz,
      cancel_requested boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      deadline_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
      UNIQUE (organization_id, creator_id, tool, request_id)
    )`)
    await runner.query('CREATE INDEX mcp_operation_work ON mcp_operation (state, lease_until, created_at)')
    await runner.query('CREATE INDEX mcp_operation_expiry ON mcp_operation (expires_at)')
    // Ambiguous remote effects cannot release capacity merely because metadata expires.
    await runner.query(`CREATE TABLE mcp_capacity_reservation (
      operation_id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      tool text NOT NULL CHECK (tool IN ('create_box', 'exec_box'))
    )`)
    await runner.query('CREATE INDEX mcp_capacity_organization ON mcp_capacity_reservation (organization_id, tool)')
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE mcp_capacity_reservation')
    await runner.query('DROP TABLE mcp_operation')
  }
}
