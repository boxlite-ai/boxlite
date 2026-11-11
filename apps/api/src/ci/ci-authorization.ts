/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ForbiddenException } from '@nestjs/common'
import { EntityManager } from 'typeorm'

export type CiActor = { organizationId: string; userId: string; apiKey?: { keyHash: string } }

/** Keep authority rows locked until the caller commits its authorized change. */
export async function lockCiAuthority(tx: EntityManager, actor: CiActor): Promise<void> {
  if (!actor.organizationId || !actor.userId) throw new ForbiddenException('An authenticated CI owner is required')
  const [user] = await tx.query('SELECT role FROM "user" WHERE id=$1 FOR SHARE', [actor.userId])
  if (!user) throw new ForbiddenException('CI actor is unavailable')
  if (user.role !== 'admin') {
    const [owner] = await tx.query(
      `SELECT role FROM organization_user WHERE "organizationId"=$1 AND "userId"=$2 AND role='owner' FOR SHARE`,
      [actor.organizationId, actor.userId],
    )
    if (!owner) throw new ForbiddenException('Current organization owner authority is required')
  }
  if (!actor.apiKey) return
  if (!/^[a-f0-9]{64}$/.test(actor.apiKey.keyHash || '')) throw new ForbiddenException('Verified API key required')
  const [key] = await tx.query(
    'SELECT permissions FROM api_key WHERE "keyHash"=$1 AND "userId"=$2 AND "organizationId"=$3 FOR SHARE',
    [actor.apiKey.keyHash, actor.userId, actor.organizationId],
  )
  if (
    !key ||
    !Array.isArray(key.permissions) ||
    !['write:boxes', 'delete:boxes'].every((p) => key.permissions.includes(p))
  )
    throw new ForbiddenException('Current API key Box permissions are required')
}

export async function assertCiKeyFresh(tx: EntityManager, actor: CiActor): Promise<void> {
  if (!actor.apiKey) return
  const [key] = await tx.query(
    `SELECT 1 FROM api_key WHERE "keyHash"=$1 AND "userId"=$2 AND "organizationId"=$3
    AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())`,
    [actor.apiKey.keyHash, actor.userId, actor.organizationId],
  )
  if (!key) throw new ForbiddenException('CI API key expired before the change completed')
}
