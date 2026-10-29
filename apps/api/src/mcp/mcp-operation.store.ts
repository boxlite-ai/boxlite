/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, GoneException, HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { EncryptionService } from '../encryption/encryption.service'
import { McpIdentity } from './mcp-authorization.service'

export interface McpOperation {
  id: string
  organization_id: string
  creator_id: string
  tool: 'create_box' | 'exec_box'
  request_id: string
  input_hash: string
  identity: McpIdentity
  payload: string | null
  state: 'queued' | 'dispatching' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown'
  process_state: 'not_started' | 'running' | 'exited' | 'unknown'
  collection_state: 'waiting' | 'collecting' | 'finished' | 'interrupted' | 'unavailable' | 'not_applicable'
  box_id: string | null
  execution_id: string | null
  exit_code: number | null
  error_code: string | null
  lease_owner: string | null
  lease_epoch: number
  lease_until: Date | null
  completed_at: Date | null
  cancel_requested: boolean
  deadline_at: Date
  expires_at: Date
}

type Progress = Pick<McpOperation, 'state' | 'process_state' | 'collection_state'> &
  Partial<Pick<McpOperation, 'box_id' | 'execution_id' | 'exit_code' | 'error_code'>>

@Injectable()
export class McpOperationStore {
  constructor(
    private readonly database: DataSource,
    private readonly encryption: EncryptionService,
  ) {}

  async reserve(
    identity: McpIdentity,
    tool: McpOperation['tool'],
    requestId: string,
    input: Record<string, unknown>,
    limits: { global: number; runtimeSeconds: number },
  ): Promise<McpOperation> {
    const serialized = JSON.stringify(canonical(input))
    const digest = createHash('sha256').update(serialized).digest('hex')
    const payload = await this.encryption.encrypt(JSON.stringify(input))
    return this.database.transaction(async (manager) => {
      // One short admission transaction protects both global and per-org caps.
      const [lock] = await manager.query("SELECT pg_try_advisory_xact_lock(hashtext('mcp-admissions')) AS acquired")
      if (!lock.acquired) throw new HttpException('MCP admission busy; retry with the same request_id', 429)
      const [existing] = await manager.query(
        'SELECT * FROM mcp_operation WHERE organization_id = $1 AND creator_id = $2 AND tool = $3 AND request_id = $4',
        [identity.organizationId, identity.userId, tool, requestId],
      )
      if (existing) {
        if (existing.expires_at <= new Date()) throw new GoneException('MCP operation expired; use a new request_id')
        if (existing.input_hash !== digest) throw new ConflictException('request_id has different inputs')
        return existing
      }
      const [counts] = await manager.query(
        `SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE organization_id = $1 AND tool = 'exec_box')::integer AS organization
         FROM mcp_capacity_reservation`,
        [identity.organizationId],
      )
      if (counts.total >= limits.global || (tool === 'exec_box' && counts.organization >= 4)) {
        throw new HttpException('MCP capacity exhausted', 429)
      }
      const [operation] = await manager.query(
        `INSERT INTO mcp_operation
          (id, organization_id, creator_id, tool, request_id, input_hash, identity, payload, deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + $9 * interval '1 second') RETURNING *`,
        [
          randomUUID(),
          identity.organizationId,
          identity.userId,
          tool,
          requestId,
          digest,
          identity,
          payload,
          // Provisioning/auto-resume gets a bounded allowance before process runtime.
          limits.runtimeSeconds + 60,
        ],
      )
      await manager.query(
        'INSERT INTO mcp_capacity_reservation (operation_id, organization_id, tool) VALUES ($1, $2, $3)',
        [operation.id, identity.organizationId, tool],
      )
      return operation
    })
  }

  async read(identity: McpIdentity, id: string): Promise<McpOperation> {
    const [operation] = await this.database.query(
      'SELECT * FROM mcp_operation WHERE id = $1 AND organization_id = $2 AND creator_id = $3',
      [id, identity.organizationId, identity.userId],
    )
    if (!operation) throw new NotFoundException('MCP operation not found')
    if (operation.expires_at <= new Date()) throw new GoneException('MCP operation expired')
    return operation
  }

  async claim(): Promise<McpOperation | undefined> {
    return this.database.transaction(async (manager) => {
      // A crashed dispatch may already have created a Box/process. Never replay it.
      await manager.query(`UPDATE mcp_operation SET state = 'outcome_unknown', process_state = 'unknown',
        collection_state = 'unavailable', error_code = 'dispatch_outcome_unknown', payload = NULL,
        lease_owner = NULL, lease_until = NULL, completed_at = now()
        WHERE state = 'dispatching' AND lease_until <= now()`)
      const [operation] = await manager.query(
        `SELECT * FROM mcp_operation WHERE
         ((state IN ('queued', 'running') AND deadline_at > now()) OR
          (state = 'outcome_unknown' AND execution_id IS NOT NULL AND cancel_requested))
         AND (lease_until IS NULL OR lease_until <= now()) AND expires_at > now()
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      )
      if (!operation) return undefined
      const [claimedRows] = await manager.query(
        `UPDATE mcp_operation SET lease_owner = $2, lease_epoch = lease_epoch + 1,
          lease_until = now() + interval '15 seconds',
          state = CASE WHEN state = 'queued' THEN 'dispatching' ELSE state END
         WHERE id = $1 RETURNING *`,
        [operation.id, randomUUID()],
      )
      return claimedRows[0]
    })
  }

  async renew(operation: McpOperation): Promise<boolean> {
    const rows = await this.database.query(
      `UPDATE mcp_operation SET lease_until = now() + interval '15 seconds'
       WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND lease_until > now()
       AND state IN ('dispatching', 'running', 'outcome_unknown') RETURNING id`,
      [operation.id, operation.lease_owner, operation.lease_epoch],
    )
    return rows[0]?.length > 0
  }

  /** Only for a claim returned before its attempt starts, never an uncertain dispatch. */
  async releaseClaim(operation: McpOperation): Promise<void> {
    await this.database.query(
      `UPDATE mcp_operation SET lease_owner = NULL, lease_until = NULL,
       state = CASE WHEN state = 'dispatching' THEN 'queued' ELSE state END
       WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3
       AND state IN ('dispatching', 'running', 'outcome_unknown')`,
      [operation.id, operation.lease_owner, operation.lease_epoch],
    )
  }

  async release(operation: McpOperation): Promise<void> {
    await this.database.query(
      `UPDATE mcp_operation SET lease_until = now(), collection_state = 'interrupted'
      WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND state = 'running'`,
      [operation.id, operation.lease_owner, operation.lease_epoch],
    )
  }

  async save(operation: McpOperation, progress: Progress): Promise<boolean> {
    const rows = await this.database.query(
      `WITH updated AS (UPDATE mcp_operation SET state = $4, process_state = $5, collection_state = $6,
        box_id = COALESCE($7, box_id), execution_id = COALESCE($8, execution_id),
        exit_code = $9, error_code = $10, payload = NULL,
        cancel_requested = cancel_requested OR
          ($4 = 'outcome_unknown' AND COALESCE($8, execution_id) IS NOT NULL AND deadline_at <= now()),
        completed_at = CASE WHEN $4 = 'running' THEN NULL ELSE now() END,
        lease_until = CASE WHEN $4 = 'running' THEN lease_until
          WHEN $4 = 'outcome_unknown' THEN now() + interval '5 seconds' ELSE NULL END
       WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND lease_until > now() RETURNING id, state),
       released AS (DELETE FROM mcp_capacity_reservation WHERE operation_id IN
         (SELECT id FROM updated WHERE state IN ('succeeded', 'failed', 'cancelled')))
       SELECT id FROM updated`,
      [
        operation.id,
        operation.lease_owner,
        operation.lease_epoch,
        progress.state,
        progress.process_state,
        progress.collection_state,
        progress.box_id,
        progress.execution_id,
        progress.exit_code,
        progress.error_code,
      ],
    )
    return rows.length > 0
  }

  async expire(): Promise<void> {
    await this.database.query(`WITH expired AS (UPDATE mcp_operation SET
      state = CASE WHEN state = 'queued' THEN 'failed' ELSE 'outcome_unknown' END,
      process_state = CASE WHEN state = 'queued' THEN 'not_started' ELSE 'unknown' END,
      collection_state = 'unavailable', error_code = 'deadline_exceeded', payload = NULL,
      cancel_requested = cancel_requested OR execution_id IS NOT NULL,
      lease_until = NULL, lease_owner = NULL, completed_at = now()
      WHERE deadline_at <= now() AND (state IN ('queued', 'dispatching', 'running') OR
        (state = 'outcome_unknown' AND execution_id IS NOT NULL AND NOT cancel_requested)) RETURNING id, state)
      DELETE FROM mcp_capacity_reservation WHERE operation_id IN (SELECT id FROM expired WHERE state = 'failed')`)
    await this.database.query('DELETE FROM mcp_operation WHERE expires_at <= now()')
  }

  async cancel(identity: McpIdentity, id: string): Promise<McpOperation> {
    const operation = await this.read(identity, id)
    if (operation.tool !== 'exec_box') throw new ConflictException('Only executions can be cancelled')
    await this.database.query(
      `WITH cancelled AS (UPDATE mcp_operation SET cancel_requested = true,
      state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END,
      payload = CASE WHEN state = 'queued' THEN NULL ELSE payload END,
      completed_at = CASE WHEN state = 'queued' THEN now() ELSE completed_at END
      WHERE id = $1 RETURNING id, state)
      DELETE FROM mcp_capacity_reservation WHERE operation_id IN (SELECT id FROM cancelled WHERE state = 'cancelled')`,
      [operation.id],
    )
    return this.read(identity, id)
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}
