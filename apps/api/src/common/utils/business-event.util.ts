/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, Logger } from '@nestjs/common'
import { getServiceType } from './app-mode'
import { Context } from '../context/context'

export type BusinessEventName =
  | 'user.registration'
  | 'user.login'
  | 'org.active'
  | 'box.create'
  | 'box.start'
  | 'box.stop'
  | 'box.delete'
  | 'box.exec'
  | 'box.file_upload'
  | 'tunnel.create'
  | 'box.open'
  | 'api_key.create'
  | 'volume.create'
  | 'volume.delete'

export interface BusinessEventBase {
  name: BusinessEventName
  // User/box/volume id, or a fresh non-secret UUID for an API-key creation attempt.
  correlationId: string
  // The organization the event belongs to, so its activity can be counted per
  // organization from the log alone. Absent on user.login, which spans organizations,
  // and on a registration until its default organization exists.
  organizationId?: string
  // Absent for runner outcomes and anonymous preview presence.
  ctx?: Context
}

export type BusinessEvent =
  | (BusinessEventBase & { outcome: 'requested' | 'success' })
  // A failure carries only its category: raw error text (runner job errors,
  // database constraint messages) can hold secrets or user data, and these
  // records feed alert labels and Slack messages.
  | (BusinessEventBase & { outcome: 'exception'; exceptionType: string })

const logger = new Logger('BusinessEvent')

/** Fixed categories keep exception messages, resource names and credentials out of telemetry. */
export function mutationFailureType(error: unknown): string {
  const status = error instanceof HttpException ? error.getStatus() : 500
  return (
    (
      { 400: 'invalid_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 503: 'unavailable' } as Record<
        number,
        string
      >
    )[status] ?? 'internal'
  )
}

/**
 * Emits one business event as a structured log record. The attributes reach
 * OTLP through nestjs-pino and PinoInstrumentation (see tracing.ts), where
 * alerts query them by name.
 */
export function recordBusinessEvent(event: BusinessEvent): void {
  const message = `${event.name} ${event.outcome}`
  const attributes = toLogAttributes(event)

  if (event.outcome === 'exception') {
    logger.error(message, attributes)
    return
  }
  logger.log(message, attributes)
}

/**
 * Records an operation's whole event lifecycle: requested before op runs, then
 * success when it resolves or exception, categorized by classifyError, when it
 * throws. The error is rethrown. organizationOf names the organization of an
 * operation that creates it, so only its success can carry it.
 */
export async function recordOutcomes<T>(
  event: BusinessEventBase,
  op: () => Promise<T>,
  classifyError: (error: unknown) => string,
  organizationOf?: (result: T) => string | undefined,
): Promise<T> {
  recordBusinessEvent({ ...event, outcome: 'requested' })
  let result: T
  try {
    result = await op()
  } catch (error) {
    recordBusinessEvent({ ...event, outcome: 'exception', exceptionType: classifyError(error) })
    throw error
  }
  const organizationId = organizationOf?.(result) ?? event.organizationId
  recordBusinessEvent({ ...event, outcome: 'success', ...(organizationId ? { organizationId } : {}) })
  return result
}

function toLogAttributes(event: BusinessEvent): Record<string, string> {
  const attributes: Record<string, string> = {
    'event.name': event.name,
    'event.outcome': event.outcome,
    'correlation.id': event.correlationId,
    'service.type': getServiceType(),
    'event.timestamp': new Date().toISOString(),
  }

  if (event.organizationId) {
    attributes['organization.id'] = event.organizationId
  }
  if (event.ctx) {
    attributes['actor.kind'] = event.ctx.actorKind
  }
  if (event.ctx?.reason) {
    attributes['event.reason'] = event.ctx.reason
  }
  const actor = event.ctx?.actor
  if (actor) {
    attributes['user.id'] = actor.userId
    attributes['auth.method'] = actor.authMethod
    if (actor.clientSource) attributes['client.source'] = actor.clientSource
    if (actor.sdkVersion) attributes['sdk.version'] = actor.sdkVersion
  }
  if (event.outcome === 'exception') {
    attributes['exception.type'] = event.exceptionType
  }

  return attributes
}
