/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import { DataSource } from 'typeorm'

type CredentialGrant = { secret_id: string }
type ActiveCredential = {
  active: true
  credential_id: string
  runner_id: string
  box_id: string
  organization_id: string
  grants: CredentialGrant[]
  expires_at: Date
}

@Injectable()
export class SecretCredentialService {
  private readonly logger = new Logger(SecretCredentialService.name)

  constructor(private readonly database: DataSource) {}

  async issue(binding: { runnerId: string; boxId: string; organizationId: string; secretIds: string[] }) {
    const token = `bxsc_${randomBytes(32).toString('base64url')}`
    const grants = binding.secretIds.map((secret_id) => ({ secret_id }))
    try {
      const [row] = await this.database.query(
        `INSERT INTO secret_credential (token_hash, runner_id, box_id, organization_id, grants, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '15 minutes') RETURNING expires_at`,
        [this.hash(token), binding.runnerId, binding.boxId, binding.organizationId, JSON.stringify(grants)],
      )
      return { token, expiresAt: row.expires_at.toISOString() }
    } catch {
      // Driver errors can include bound parameters; never propagate grants or hashes to logging interceptors.
      throw new ServiceUnavailableException('Could not issue secret credential')
    }
  }

  async consume(token: unknown, runnerId: unknown): Promise<ActiveCredential | { active: false }> {
    if (
      typeof token !== 'string' ||
      !/^bxsc_[A-Za-z0-9_-]{43}$/.test(token) ||
      typeof runnerId !== 'string' ||
      runnerId.length === 0 ||
      runnerId.length > 64
    ) {
      return { active: false }
    }
    const hash = this.hash(token)
    try {
      // PostgreSQL rechecks the predicates after waiting for a competing consumer's row lock.
      const [rows] = await this.database.query(
        `UPDATE secret_credential SET used_at = now()
         WHERE token_hash = $1 AND runner_id = $2 AND used_at IS NULL AND expires_at > now()
         RETURNING id AS credential_id, runner_id, box_id, organization_id, grants, expires_at`,
        [hash, runnerId],
      )
      if (rows.length) return { active: true, ...rows[0] }
      const [used] = await this.database.query(
        'SELECT id FROM secret_credential WHERE token_hash = $1 AND used_at IS NOT NULL',
        [hash],
      )
      if (used) this.logger.warn(`Secret credential replay: credential_id=${used.id}`)
      return { active: false }
    } catch {
      throw new ServiceUnavailableException('Could not consume secret credential')
    }
  }

  private hash(token: string): Buffer {
    return createHash('sha256').update(token).digest()
  }
}
