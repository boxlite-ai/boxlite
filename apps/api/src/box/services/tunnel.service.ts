/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Tunnel } from '../entities/tunnel.entity'

@Injectable()
export class TunnelService {
  constructor(@InjectRepository(Tunnel) private readonly tunnels: Repository<Tunnel>) {}

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
  }

  async revoke(boxId: string, port: number): Promise<void> {
    this.assertPort(port)
    const result = await this.tunnels.update({ boxId, port, accessMode: 'public' }, { revokedAt: new Date() })
    if (!result.affected) {
      throw new NotFoundException('Tunnel not found')
    }
  }

  async isPublicAccessAllowed(boxId: string, port: number): Promise<boolean> {
    this.assertPort(port)
    return this.tunnels
      .createQueryBuilder('tunnel')
      .innerJoin('tunnel.box', 'box')
      .where('tunnel.box_id = :boxId', { boxId })
      .andWhere('tunnel.port = :port', { port })
      .andWhere('tunnel.access_mode = :mode', { mode: 'public' })
      .andWhere('tunnel.revoked_at IS NULL')
      .andWhere('box.public = true')
      .andWhere('box.state NOT IN (:...excluded)', { excluded: ['destroyed', 'destroying', 'archived', 'archiving'] })
      .getExists()
  }

  private assertPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestError('Invalid tunnel port')
    }
  }
}
