/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { createHash, randomBytes } from 'crypto'

export const ATTACH_TICKET_TTL_SECONDS = 30

/** Who may attach, and to which execution. The ticket authorizes nothing else. */
export type AttachTicketGrant = {
  userId: string
  organizationId: string
  boxId: string
  execId: string
  /** The API key that bought the ticket, if any: it, not the user's role, authorizes the attach. */
  apiKeyHash?: string
}

/**
 * One-time credentials for the attach WebSocket. A browser cannot set an
 * `Authorization` header on `new WebSocket`, so the dashboard trades its bearer
 * for a ticket over HTTPS and puts the ticket in the attach URL.
 *
 * A URL can end up in access logs, so a ticket is single-use (`GETDEL`), lives
 * 30 seconds, and is stored only as its SHA-256 hash.
 */
@Injectable()
export class AttachTicketService {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async issue(grant: AttachTicketGrant): Promise<string> {
    const ticket = randomBytes(32).toString('base64url')
    await this.redis.set(this.key(ticket), JSON.stringify(grant), 'EX', ATTACH_TICKET_TTL_SECONDS)
    return ticket
  }

  /** The grant for `ticket`, at most once; null when unknown, expired or spent. */
  async consume(ticket: string): Promise<AttachTicketGrant | null> {
    const stored = await this.redis.getdel(this.key(ticket))
    return stored ? (JSON.parse(stored) as AttachTicketGrant) : null
  }

  private key(ticket: string): string {
    return `attach-ticket:${createHash('sha256').update(ticket).digest('hex')}`
  }
}
