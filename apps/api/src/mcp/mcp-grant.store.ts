/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import type { McpScope } from './mcp-authorization.service'

export interface McpGrant {
  id: string
  organization_id: string
  user_id: string
  client_id: string
  client_name: string
  resource: string
  scopes: McpScope[]
  challenge_nonce: string
  expires_at: Date
  revoked_at: Date | null
}

@Injectable()
export class McpGrantStore {
  constructor(private readonly database: DataSource) {}

  async create(grant: Omit<McpGrant, 'id' | 'expires_at' | 'revoked_at'>): Promise<McpGrant> {
    const rows = await this.database.query(
      `INSERT INTO mcp_grant
      (id, organization_id, user_id, client_id, client_name, resource, scopes, challenge_nonce)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (challenge_nonce) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        grant.organization_id,
        grant.user_id,
        grant.client_id,
        grant.client_name,
        grant.resource,
        grant.scopes,
        grant.challenge_nonce,
      ],
    )
    if (!rows[0]) throw new ConflictException('Consent challenge already used; restart authorization')
    return rows[0]
  }

  async read(id: string): Promise<McpGrant> {
    const [grant] = await this.database.query('SELECT * FROM mcp_grant WHERE id = $1', [id])
    if (!grant || grant.revoked_at || grant.expires_at <= new Date())
      throw new UnauthorizedException('MCP grant expired or revoked')
    return grant
  }

  async list(userId: string): Promise<McpGrant[]> {
    return this.database.query(
      `SELECT id, organization_id, client_id, client_name, scopes, expires_at, revoked_at
      FROM mcp_grant WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 100`,
      [userId],
    )
  }

  async revoke(userId: string, id: string): Promise<void> {
    const [rows] = await this.database.query(
      'UPDATE mcp_grant SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId],
    )
    if (!rows.length) throw new NotFoundException('MCP grant not found')
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'mcp-grant-expiry', waitForCompletion: true })
  async expire(): Promise<void> {
    await this.database.query("DELETE FROM mcp_grant WHERE expires_at < now() - interval '24 hours'")
  }
}
