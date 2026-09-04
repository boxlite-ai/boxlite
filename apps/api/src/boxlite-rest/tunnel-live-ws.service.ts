/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2025 BoxLite AI
 */

import { Injectable, Logger } from '@nestjs/common'
import type { IncomingMessage } from 'http'
import type { Socket } from 'net'
import * as ws from 'ws'
import { InjectRedis } from '@nestjs-modules/ioredis'
import { Redis } from 'ioredis'
import { ApiKeyService } from '../api-key/api-key.service'
import { OrganizationService } from '../organization/services/organization.service'
import { BoxService } from '../box/services/box.service'

// Matches /api/v1/boxes/<boxId>/network/tunnel/live
// and    /api/v1/<tenant>/boxes/<boxId>/network/tunnel/live
const TUNNEL_LIVE_PATH = /^\/api\/v1\/(?:[^/]+\/)?boxes\/(?<boxId>[^/?]+)\/network\/tunnel\/live(?:\?.*)?$/

const TUNNEL_LIVE_KEY_PREFIX = 'box:network-tunnel-live:'

// Ping every 20s so load balancers / NAT don't kill idle connections.
const PING_INTERVAL_MS = 20_000

/**
 * WebSocket handler for the tunnel-live keepalive endpoint.
 *
 * When the CLI opens a tunnel it connects here. On connect the service sets
 * the Redis liveness key (no TTL); the Go proxy checks this key before
 * forwarding browser traffic. On disconnect the key is deleted immediately,
 * so browser access lapses as soon as the CLI exits — without any TTL
 * residual window.
 *
 * Authentication mirrors the API-key path of CombinedAuthGuard: the CLI
 * sends `Authorization: Bearer <api-key>` in the WS handshake headers.
 */
@Injectable()
export class TunnelLiveWsService {
  private readonly logger = new Logger(TunnelLiveWsService.name)
  private readonly wss = new ws.WebSocketServer({ noServer: true })

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly organizationService: OrganizationService,
    private readonly boxService: BoxService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  matchPath(url: string | undefined): boolean {
    return !!url && TUNNEL_LIVE_PATH.test(url)
  }

  async upgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const match = TUNNEL_LIVE_PATH.exec(req.url ?? '')
    const boxId = match?.groups?.boxId
    if (!boxId) {
      socket.destroy()
      return
    }

    // Authenticate via API key from Authorization header.
    const authHeader = req.headers['authorization'] ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    let organizationId: string
    try {
      const apiKey = await this.apiKeyService.getApiKeyByValue(token)
      if (!apiKey) throw new Error('invalid key')
      organizationId = apiKey.organizationId
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    // Verify the box belongs to this organization and is public.
    try {
      const box = await this.boxService.findOneByIdOrName(boxId, organizationId)
      if (!box.public) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
    } catch {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    this.wss.handleUpgrade(req, socket, head, (connection) => {
      void this.handleConnection(connection, boxId)
    })
  }

  private async handleConnection(connection: ws.WebSocket, boxId: string): Promise<void> {
    const key = TUNNEL_LIVE_KEY_PREFIX + boxId
    this.logger.log(`tunnel live: box=${boxId} connected`)

    await this.redis.set(key, '1')

    const ping = setInterval(() => {
      if (connection.readyState === ws.WebSocket.OPEN) {
        connection.ping()
      }
    }, PING_INTERVAL_MS)

    const cleanup = async (): Promise<void> => {
      clearInterval(ping)
      await this.redis.del(key)
      this.logger.log(`tunnel live: box=${boxId} disconnected, key deleted`)
    }

    connection.once('close', () => void cleanup())
    connection.once('error', () => void cleanup())
  }
}
