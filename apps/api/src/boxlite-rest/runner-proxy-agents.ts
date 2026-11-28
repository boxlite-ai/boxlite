/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { Injectable, OnModuleDestroy } from '@nestjs/common'
import http from 'node:http'
import https from 'node:https'
import type { Socket } from 'node:net'

export const RUNNER_PROXY_IDLE_SOCKET_TIMEOUT_MS = 45_000
const MAX_SOCKETS_PER_ORIGIN = 64
const MAX_FREE_SOCKETS_PER_ORIGIN = 16
const MAX_TOTAL_SOCKETS_PER_PROTOCOL = 512

@Injectable()
export class RunnerProxyAgents implements OnModuleDestroy {
  readonly http: http.Agent
  readonly https: https.Agent
  private readonly idleSockets = new Map<Socket, NodeJS.Timeout>()
  private readonly trackedSockets = new WeakSet<Socket>()

  constructor() {
    const options = {
      keepAlive: true,
      maxSockets: MAX_SOCKETS_PER_ORIGIN,
      maxFreeSockets: MAX_FREE_SOCKETS_PER_ORIGIN,
      maxTotalSockets: MAX_TOTAL_SOCKETS_PER_PROTOCOL,
    }
    this.http = this.manageIdleSockets(new http.Agent(options))
    this.https = this.manageIdleSockets(new https.Agent(options))
  }

  forTarget(target: string): http.Agent | https.Agent {
    return target.toLowerCase().startsWith('https:') ? this.https : this.http
  }

  private manageIdleSockets<T extends http.Agent>(agent: T): T {
    agent.on('free', (socket: Socket) => {
      this.clearIdleTimer(socket)
      const timer = setTimeout(() => {
        if (this.idleSockets.get(socket) !== timer) return
        this.idleSockets.delete(socket)
        socket.destroy()
      }, RUNNER_PROXY_IDLE_SOCKET_TIMEOUT_MS)
      timer.unref()
      this.idleSockets.set(socket, timer)
      if (!this.trackedSockets.has(socket)) {
        this.trackedSockets.add(socket)
        socket.once('close', () => this.clearIdleTimer(socket))
      }
    })
    agent.on('reuse', (socket: Socket) => this.clearIdleTimer(socket))
    return agent
  }

  private clearIdleTimer(socket: Socket): void {
    const timer = this.idleSockets.get(socket)
    if (timer) clearTimeout(timer)
    this.idleSockets.delete(socket)
  }

  onModuleDestroy(): void {
    for (const timer of this.idleSockets.values()) clearTimeout(timer)
    this.idleSockets.clear()
    this.http.destroy()
    this.https.destroy()
  }
}
