/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { Logger } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import { AuditService } from '../audit/services/audit.service'
import { AuditAction } from '../audit/enums/audit-action.enum'
import { AuditTarget } from '../audit/enums/audit-target.enum'

type AttachIdentity = { actorId: string; actorEmail: string; organizationId: string; targetId: string }

/** Owns one upgrade's audit lifecycle, independent of the shared proxy. */
export class AttachAuditSession {
  private readonly logger = new Logger(AttachAuditSession.name)
  private readonly metadata: { connectionId: string; executionId: string }
  private logId?: string
  private request?: ClientRequest
  private upstream?: Socket
  private connected?: { at: string; started: number }
  private closed = false
  private completed = false
  private hadError = false

  private constructor(
    private readonly audit: AuditService,
    private readonly client: Socket,
    private readonly identity: AttachIdentity,
    executionId: string,
  ) {
    this.metadata = { connectionId: randomUUID(), executionId }
    client.once('close', this.onClose)
    client.once('end', this.onClientEnd)
    client.on('error', this.onError)
  }

  static async start(
    audit: AuditService,
    client: Socket,
    identity: AttachIdentity,
    executionId: string,
  ): Promise<AttachAuditSession | undefined> {
    const session = new AttachAuditSession(audit, client, identity, executionId)
    try {
      const log = await audit.createLog({
        ...identity,
        action: AuditAction.ATTACH,
        targetType: AuditTarget.BOX,
        source: 'websocket-attach',
        metadata: session.metadata,
      })
      session.logId = log.id
    } catch (error) {
      session.cleanup()
      throw error
    }
    if (session.closed || client.destroyed || client.readableEnded) {
      client.destroy()
      session.onClose()
      session.completeAttach(0)
      return undefined
    }
    return session
  }

  bind(request: ClientRequest): void {
    if (this.closed) {
      request.destroy()
      return
    }
    this.request = request
    request.once('upgrade', this.onUpgrade)
    request.once('response', this.onResponse)
    request.once('error', this.onRequestError)
  }

  private readonly onUpgrade = (_response: IncomingMessage, upstream: Socket): void => {
    if (this.closed || this.client.destroyed || this.client.readableEnded) {
      upstream.destroy()
      this.onClose()
      return
    }
    // This precedes httpxy's write of 101: it proves Runner acceptance, not client receipt.
    this.connected = { at: new Date().toISOString(), started: performance.now() }
    this.client.removeListener('end', this.onClientEnd)
    this.upstream = upstream
    upstream.once('close', this.onClose)
    upstream.on('error', this.onError)
    this.removeRequestListeners()
    this.completeAttach(101)
  }

  private readonly onResponse = (response: IncomingMessage): void => {
    this.completeAttach(response.statusCode ?? 0)
    this.closed = true
    this.cleanup()
  }

  private readonly onError = (): void => {
    this.hadError = true
  }

  private readonly onClientEnd = (): void => {
    // Before piping starts, a peer FIN leaves this half-open socket alive.
    this.client.destroy()
  }

  private readonly onRequestError = (): void => {
    this.onClose(true)
  }

  private readonly onClose = (hadError = false): void => {
    if (this.closed) return
    // Claim closure before any persistence; both sockets may emit it in the same turn.
    this.closed = true
    this.hadError ||= hadError
    this.cleanup()
    if (!this.connected) {
      this.request?.destroy()
      this.completeAttach(0)
      return
    }
    void this.audit
      .createLog({
        ...this.identity,
        action: AuditAction.DETACH,
        targetType: AuditTarget.BOX,
        source: 'websocket-attach',
        // Internal event success, not an HTTP response or WebSocket close code.
        statusCode: 200,
        metadata: {
          ...this.metadata,
          connectedAt: this.connected.at,
          disconnectedAt: new Date().toISOString(),
          durationMs: Math.max(0, Math.round(performance.now() - this.connected.started)),
          hadError: this.hadError,
        },
      })
      .catch(() => this.logger.warn('Failed to persist attach disconnect audit'))
  }

  private completeAttach(statusCode: number): void {
    if (this.completed || !this.logId) return
    this.completed = true
    void this.audit
      .updateLog(this.logId, {
        statusCode,
        ...(this.connected ? { metadata: { connectedAt: this.connected.at } } : {}),
      })
      .catch(() => this.logger.warn('Failed to complete attach audit'))
  }

  private removeRequestListeners(): void {
    this.request?.removeListener('upgrade', this.onUpgrade)
    this.request?.removeListener('response', this.onResponse)
    this.request?.removeListener('error', this.onRequestError)
  }

  private cleanup(): void {
    this.removeRequestListeners()
    this.client.removeListener('close', this.onClose)
    this.client.removeListener('end', this.onClientEnd)
    this.client.removeListener('error', this.onError)
    this.upstream?.removeListener('close', this.onClose)
    this.upstream?.removeListener('error', this.onError)
  }
}
