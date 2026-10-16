/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Logger } from '@nestjs/common'
import { getServiceType } from './app-mode'
import { Context } from '../context/context'

export type BusinessEventName = 'user.registration' | 'user.login' | 'box.create' | 'box.stop' | 'box.delete'

export interface BusinessEventBase {
  name: BusinessEventName
  // The user id for a registration, the box id for a box event. Anything else
  // about that entity, such as its organization, is read from its table.
  correlationId: string
  // Absent only on job outcome events: the runner reports after the request ends.
  ctx?: Context
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

/**
 * Records an operation's whole event lifecycle: requested before op runs, then
 * success when it resolves or exception, categorized by classifyError, when it
 * throws. The error is rethrown.
 */
export async function recordOutcomes<T>(
  event: BusinessEventBase,
  op: () => Promise<T>,
  classifyError: (error: unknown) => string,
): Promise<T> {
  recordBusinessEvent({ ...event, outcome: 'requested' })
  let result: T
  try {
    result = await op()
  } catch (error) {
    recordBusinessEvent({ ...event, outcome: 'exception', exceptionType: classifyError(error) })
    throw error
  }
  recordBusinessEvent({ ...event, outcome: 'success' })
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

  if (event.ctx) {
    attributes['actor.kind'] = event.ctx.actorKind
  }
  if (event.ctx?.reason) {
    attributes['event.reason'] = event.ctx.reason
  }
  if (event.outcome === 'exception') {
    attributes['exception.type'] = event.exceptionType
  }

  return attributes
}
