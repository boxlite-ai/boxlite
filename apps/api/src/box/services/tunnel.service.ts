/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { Repository } from 'typeorm'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Tunnel } from '../entities/tunnel.entity'

// The proxy asks on every request. prepare and revoke evict the entry, so the
// window bounds only inbound and box-state changes, and a lookup racing a revoke.
const ACCESS_CACHE_TTL_SECONDS = 3

type ActiveTunnel = Pick<Tunnel, 'id' | 'accessMode' | 'tokenHash' | 'authGeneration'>

@Injectable()
export class TunnelService {
  constructor(
    @InjectRepository(Tunnel) private readonly tunnels: Repository<Tunnel>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async prepare(boxId: string, port: number, isPublic = true): Promise<{ isPublic: boolean; token: string | null }> {
    this.assertPort(port)
    const token = isPublic ? null : `blt_${randomBytes(32).toString('base64url')}`
    const hash = token ? this.hash(token) : null
    const mask = token ? `blt_****************************${token.slice(-4)}` : null
    const rows: { token_hash: string | null; token_mask: string | null }[] = await this.tunnels.query(
      `INSERT INTO "tunnel" ("box_id", "port", "access_mode", "token_hash", "token_mask") VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("box_id", "port") DO UPDATE SET
         "access_mode" = EXCLUDED."access_mode",
         "token_hash" = CASE WHEN "tunnel"."revoked_at" IS NOT NULL THEN EXCLUDED."token_hash" ELSE "tunnel"."token_hash" END,
         "token_mask" = CASE WHEN "tunnel"."revoked_at" IS NOT NULL THEN EXCLUDED."token_mask" ELSE "tunnel"."token_mask" END,
         "auth_generation" = "tunnel"."auth_generation" + CASE WHEN "tunnel"."revoked_at" IS NOT NULL THEN 1 ELSE 0 END,
         "revoked_at" = NULL
       WHERE "tunnel"."revoked_at" IS NOT NULL OR "tunnel"."access_mode" = EXCLUDED."access_mode"
       RETURNING "token_hash", "token_mask"`,
      [boxId, port, isPublic ? 'public' : 'private', hash, mask],
    )
    if (rows.length === 0) {
      throw new ConflictException('Tunnel access mode differs; revoke it before recreating')
    }
    await this.evictAccess(boxId, port)
    return { isPublic, token: isPublic ? null : rows[0].token_hash === hash ? token : rows[0].token_mask }
  }

  /**
   * Withdraw a port's declaration. Repeating it, or naming a port never
   * declared, changes nothing. Connections already open are not closed.
   */
  async revoke(boxId: string, port: number): Promise<void> {
    this.assertPort(port)
    await this.tunnels.query(
      `UPDATE "tunnel" SET "revoked_at" = now(), "auth_generation" = "auth_generation" + 1
       WHERE "box_id" = $1 AND "port" = $2 AND "revoked_at" IS NULL`,
      [boxId, port],
    )
    await this.evictAccess(boxId, port)
  }

  /** Proxy-only metadata: never return the verifier or the token display value. */
  async access(boxId: string, port: number, token?: string) {
    this.assertPort(port)
    const tunnel = await this.activeTunnel(boxId, port)
    if (!tunnel) throw new NotFoundException('Tunnel not found')
    const isPublic = tunnel.accessMode === 'public'
    // A public tunnel admits every visitor, so a token there is neither required nor checked.
    if (token !== undefined && !isPublic) {
      const supplied = Buffer.from(this.hash(token), 'hex')
      const expected = Buffer.from(tunnel.tokenHash ?? '', 'hex')
      if (
        !/^blt_[A-Za-z0-9_-]{43}$/.test(token) ||
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      ) {
        // The proxy service is authenticated. A rejected visitor proof must not
        // increment the API's failed-service-auth counter for the proxy IP.
        throw new ForbiddenException('Invalid tunnel token')
      }
    }
    return {
      id: tunnel.id,
      boxId,
      port,
      isPublic,
      authGeneration: tunnel.authGeneration,
    }
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  async issueHandoff(grant: string): Promise<string> {
    const ticket = randomBytes(32).toString('base64url')
    await this.redis.set(`tunnel-handoff:${this.hash(ticket)}`, grant, 'EX', 30)
    return ticket
  }

  async consumeHandoff(ticket: string): Promise<string> {
    const grant = await this.redis.getdel(`tunnel-handoff:${this.hash(ticket)}`)
    if (!grant) throw new ForbiddenException('Invalid or expired login handoff')
    return grant
  }

  async isPublicAccessAllowed(boxId: string, port: number): Promise<boolean> {
    this.assertPort(port)
    return (await this.activeTunnel(boxId, port))?.accessMode === 'public'
  }

  private async activeTunnel(boxId: string, port: number): Promise<ActiveTunnel | null> {
    const cacheKey = this.accessCacheKey(boxId, port)
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached) as ActiveTunnel | null
    }
    const tunnel = await this.tunnels
      .createQueryBuilder('tunnel')
      .innerJoin('tunnel.box', 'box')
      .where('tunnel.box_id = :boxId', { boxId })
      .andWhere('tunnel.port = :port', { port })
      .andWhere('tunnel.revoked_at IS NULL')
      .andWhere('box.inboundEnabled = true')
      .andWhere('box.state NOT IN (:...excluded)', { excluded: ['destroyed', 'destroying', 'archived', 'archiving'] })
      .getOne()
    const active = tunnel
      ? { id: tunnel.id, accessMode: tunnel.accessMode, tokenHash: tunnel.tokenHash, authGeneration: tunnel.authGeneration }
      : null
    await this.redis.setex(cacheKey, ACCESS_CACHE_TTL_SECONDS, JSON.stringify(active))
    return active
  }

  // API replicas from before private tunnels still read the legacy '1'/'0' key.
  private async evictAccess(boxId: string, port: number): Promise<void> {
    await this.redis.del(this.accessCacheKey(boxId, port), `preview:tunnel:${boxId}:${port}`)
  }

  private accessCacheKey(boxId: string, port: number): string {
    return `preview:tunnel-access:${boxId}:${port}`
  }

  private assertPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestError('Invalid tunnel port')
    }
  }
}
