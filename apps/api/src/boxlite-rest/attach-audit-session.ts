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

const WRITE_TIMEOUT_MS = 5000
const logger = new Logger('AttachAuditSession')
const reportCreateFailure = () => logger.warn('Failed to create attach audit')
const reportCompletionFailure = () => logger.warn('Failed to complete attach audit')
const reportDisconnectFailure = () => logger.warn('Failed to persist attach disconnect audit')

type AttachIdentity = { actorId: string; actorEmail: string; organizationId: string; targetId: string }

/** Owns one upgrade's audit lifecycle, independent of the shared proxy. */
export class AttachAuditSession {
  private readonly metadata: { connectionId: string; executionId: string }
  private logId?: string
  private request?: ClientRequest
  private upstream?: Socket
  private client?: Socket
  private connected?: { at: string; started: number }
  private closed = false
  private completed = false
  private hadError = false
  private writes: Promise<void> = Promise.resolve()

  private constructor(
    private readonly audit: AuditService,
    client: Socket,
    private readonly identity: AttachIdentity,
    executionId: string,
  ) {
    this.metadata = { connectionId: randomUUID(), executionId }
    this.client = client
    client.once('close', this.onClose)
    client.once('end', this.onClientEnd)
    client.on('error', this.onError)
  }

  static start(
    audit: AuditService,
    client: Socket,
    identity: AttachIdentity,
    executionId: string,
  ): AttachAuditSession | undefined {
    const session = new AttachAuditSession(audit, client, identity, executionId)
    session.enqueueWrite(reportCreateFailure, async () => {
      const log = await audit.createLog(
        {
          ...identity,
          action: AuditAction.ATTACH,
          targetType: AuditTarget.BOX,
          source: 'websocket-attach',
          metadata: session.metadata,
        },
        WRITE_TIMEOUT_MS,
      )
      session.logId = log.id
    })
    if (session.closed || client.destroyed || client.readableEnded) {
      client.destroy()
      session.onClose()
      return undefined
    }
    return session
  }

  private enqueueWrite(reportFailure: () => void, write: () => Promise<void>): void {
    this.writes = this.writes.then(write).catch(reportFailure)
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
    if (!this.client || this.closed || this.client.destroyed || this.client.readableEnded) {
      upstream.destroy()
      this.onClose()
      return
    }
    // This precedes httpxy's write of 101: it proves Runner acceptance, not client receipt.
    this.connected = { at: new Date().toISOString(), started: performance.now() }
    this.client?.removeListener('end', this.onClientEnd)
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
    this.client?.destroy()
  }

  private readonly onRequestError = (): void => {
    this.onClose(true)
  }

  private readonly onClose = (hadError = false): void => {
    if (this.closed) return
    // Claim closure before any persistence; both sockets may emit it in the same turn.
    this.closed = true
    this.hadError ||= hadError
    const request = this.request
    this.cleanup()
    if (!this.connected) {
      request?.destroy()
      this.completeAttach(0)
      return
    }
    const connected = this.connected
    const disconnectedAt = new Date().toISOString()
    const durationMs = Math.max(0, Math.round(performance.now() - connected.started))
    this.enqueueWrite(reportDisconnectFailure, async () => {
      await this.audit.createLog(
        {
          ...this.identity,
          action: AuditAction.DETACH,
          targetType: AuditTarget.BOX,
          source: 'websocket-attach',
          // Internal event success, not an HTTP response or WebSocket close code.
          statusCode: 200,
          metadata: {
            ...this.metadata,
            connectedAt: connected.at,
            disconnectedAt,
            durationMs,
            hadError: this.hadError,
          },
        },
        WRITE_TIMEOUT_MS,
      )
    })
  }

  private completeAttach(statusCode: number): void {
    if (this.completed) return
    this.completed = true
    const connectedAt = this.connected?.at
    this.enqueueWrite(reportCompletionFailure, async () => {
      if (!this.logId) return
      await this.audit.updateLog(
        this.logId,
        { statusCode, ...(connectedAt ? { metadata: { connectedAt } } : {}) },
        WRITE_TIMEOUT_MS,
      )
    })
  }

  private removeRequestListeners(): void {
    this.request?.removeListener('upgrade', this.onUpgrade)
    this.request?.removeListener('response', this.onResponse)
    this.request?.removeListener('error', this.onRequestError)
  }

  private cleanup(): void {
    this.removeRequestListeners()
    this.client?.removeListener('close', this.onClose)
    this.client?.removeListener('end', this.onClientEnd)
    this.client?.removeListener('error', this.onError)
    this.upstream?.removeListener('close', this.onClose)
    this.upstream?.removeListener('error', this.onError)
    this.client = undefined
    this.upstream = undefined
    this.request = undefined
  }
}
