/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { Repository } from 'typeorm'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Tunnel } from '../entities/tunnel.entity'

const TERMINAL_PORT = 22222
// Same window as the other preview checks (preview:public, preview:token): the proxy
// asks on every request, and a revoked or unpublished tunnel stays open this long.
const ACCESS_CACHE_TTL_SECONDS = 3

@Injectable()
export class TunnelService {
  constructor(
    @InjectRepository(Tunnel) private readonly tunnels: Repository<Tunnel>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async declarePublic(boxId: string, port: number): Promise<void> {
    this.assertPort(port)
    const rows: { id: string }[] = await this.tunnels.query(
      `INSERT INTO "tunnel" ("box_id", "port", "access_mode") VALUES ($1, $2, 'public')
       ON CONFLICT ("box_id", "port") DO UPDATE SET "revoked_at" = NULL
       WHERE "tunnel"."access_mode" = 'public' RETURNING "id"`,
      [boxId, port],
    )
    if (rows.length === 0) {
      throw new ConflictException('Port already has a non-public tunnel')
    }
    await this.redis.del(this.accessCacheKey(boxId, port))
  }

  async isPublicAccessAllowed(boxId: string, port: number): Promise<boolean> {
    this.assertPort(port)
    const cacheKey = this.accessCacheKey(boxId, port)
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      return cached === '1'
    }
    const allowed = await this.tunnels
      .createQueryBuilder('tunnel')
      .innerJoin('tunnel.box', 'box')
      .where('tunnel.box_id = :boxId', { boxId })
      .andWhere('tunnel.port = :port', { port })
      .andWhere('tunnel.access_mode = :mode', { mode: 'public' })
      .andWhere('tunnel.revoked_at IS NULL')
      .andWhere('box.public = true')
      .andWhere('box.state NOT IN (:...excluded)', { excluded: ['destroyed', 'destroying', 'archived', 'archiving'] })
      .getExists()
    await this.redis.setex(cacheKey, ACCESS_CACHE_TTL_SECONDS, allowed ? '1' : '0')
    return allowed
  }

  private accessCacheKey(boxId: string, port: number): string {
    return `preview:tunnel:${boxId}:${port}`
  }

  private assertPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === TERMINAL_PORT) {
      throw new BadRequestError('Invalid tunnel port')
    }
  }
}
