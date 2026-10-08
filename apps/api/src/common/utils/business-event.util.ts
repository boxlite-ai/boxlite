/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { getServiceType } from './app-mode'

export type BusinessEventName = 'user.registration' | 'user.login' | 'box.create' | 'box.stop' | 'box.delete'

export type BusinessEventActorKind = 'user' | 'admin' | 'auto_stop' | 'auto_delete' | 'org_suspension' | 'warm_pool'

interface BusinessEventBase {
  name: BusinessEventName
  // The user id for a registration, the box id for a box event.
  correlationId: string
  orgId?: string
  actorKind?: BusinessEventActorKind
}

export type BusinessEvent =
  | (BusinessEventBase & { outcome: 'requested' | 'success' })
  // A failure carries only its category: raw error text (runner job errors,
  // database constraint messages) can hold secrets or user data, and these
  // records feed alert labels and Slack messages.
  | (BusinessEventBase & { outcome: 'exception'; exceptionType: string })

const logger = new Logger('BusinessEvent')

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

function toLogAttributes(event: BusinessEvent): Record<string, string> {
  const attributes: Record<string, string> = {
    'event.name': event.name,
    'event.outcome': event.outcome,
    'correlation.id': event.correlationId,
    'service.type': getServiceType(),
    'event.timestamp': new Date().toISOString(),
  }

  if (event.orgId) {
    attributes['org.id'] = event.orgId
  }
  if (event.actorKind) {
    attributes['actor.kind'] = event.actorKind
  }
  if (event.outcome === 'exception') {
    attributes['exception.type'] = event.exceptionType
  }

  return attributes
}
