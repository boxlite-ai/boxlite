/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, Logger } from '@nestjs/common'
import { v4 } from 'uuid'
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
  | 'cloud.box.create'
  | 'cloud.box.start'
  | 'cloud.box.resume'
  | 'cloud.feature.use'

export interface BusinessEventFeature {
  name: 'ssh' | 'tunnel' | 'ci' | 'custom_image'
  evidence: 'authenticated_session' | 'established_connection' | 'successful_request' | 'executed_job' | 'started_image'
  source: 'runner' | 'proxy' | 'api'
}

export interface BusinessEventOperation {
  id: string
  requestedAt: Date
  scope: 'rest_api' | 'proxy_api'
  result?: 'success' | 'service_error' | 'timeout' | 'user_error' | 'cancelled'
  durationMs?: number
  boxId?: string
}

export interface BusinessEventJobTiming {
  id: string
  createdAt?: Date | null
  startedAt?: Date | null
  completedAt?: Date | null
}

export interface BusinessEventBase {
  name: BusinessEventName
  eventId?: string
  occurredAt?: Date
  job?: Readonly<BusinessEventJobTiming>
  operation?: Readonly<BusinessEventOperation>
  feature?: Readonly<BusinessEventFeature>
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
const subscribers = new Set<(attributes: Readonly<Record<string, string>>) => void>()

/** The analytics owner subscribes once and disposes its listener during shutdown. */
export function subscribeBusinessEvents(listener: (attributes: Readonly<Record<string, string>>) => void): () => void {
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
  }
}

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
  const attributes = Object.freeze(toLogAttributes(event))

  if (event.outcome === 'exception') {
    logger.error(message, attributes)
  } else {
    logger.log(message, attributes)
  }
  for (const listener of subscribers) {
    try {
      listener(attributes)
    } catch {
      logger.warn('Business event analytics capture failed')
    }
  }
}

/**
 * Records an operation's whole event lifecycle: requested before op runs, then
 * success when it resolves or exception, categorized by classifyError, when it
 * throws. The error is rethrown. organizationOf names the organization of an
 * operation that creates it, so only its success can carry it.
 */
export async function recordOutcomes<T>(
  event: Omit<BusinessEventBase, 'eventId' | 'occurredAt' | 'job' | 'operation' | 'feature'>,
  op: () => Promise<T>,
  classifyError: (error: unknown) => string,
  organizationOf?: (result: T) => string | undefined,
): Promise<T> {
  // Occurrence overrides belong to individual emissions, never a whole lifecycle.
  const lifecycleEvent = {
    name: event.name,
    correlationId: event.correlationId,
    organizationId: event.organizationId,
    ctx: event.ctx,
  }
  recordBusinessEvent({ ...lifecycleEvent, outcome: 'requested' })
  let result: T
  try {
    result = await op()
  } catch (error) {
    recordBusinessEvent({ ...lifecycleEvent, outcome: 'exception', exceptionType: classifyError(error) })
    throw error
  }
  const organizationId = organizationOf?.(result) ?? event.organizationId
  recordBusinessEvent({ ...lifecycleEvent, outcome: 'success', ...(organizationId ? { organizationId } : {}) })
  return result
}

function toLogAttributes(event: BusinessEvent): Record<string, string> {
  const attributes: Record<string, string> = {
    'event.name': event.name,
    'event.id': event.eventId ?? v4(),
    'event.outcome': event.outcome,
    'correlation.id': event.correlationId,
    'service.type': getServiceType(),
    'event.timestamp': isoTimestamp(event.occurredAt) ?? new Date().toISOString(),
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

  if (event.operation) {
    const operation = event.operation
    attributes['operation.id'] = operation.id
    attributes['operation.requested_at'] = operation.requestedAt.toISOString()
    attributes['operation.scope'] = operation.scope
    attributes['operation.boundary'] = 'cloud_api_to_started'
    attributes['traffic.kind'] = 'unknown'
    if (operation.result) attributes['operation.result'] = operation.result
    if (operation.boxId) attributes['box.id'] = operation.boxId
    if (
      typeof operation.durationMs === 'number' &&
      Number.isFinite(operation.durationMs) &&
      operation.durationMs >= 0
    ) {
      attributes['operation.duration_ms'] = String(operation.durationMs)
    }
  }

  if (event.feature) {
    attributes['feature.name'] = event.feature.name
    attributes['feature.evidence'] = event.feature.evidence
    attributes['feature.source'] = event.feature.source
  }

  if (event.job) {
    const job = event.job
    attributes['job.id'] = job.id
    for (const [key, date] of [
      ['job.created_at', job.createdAt],
      ['job.started_at', job.startedAt],
      ['job.completed_at', job.completedAt],
    ] as const) {
      const timestamp = isoTimestamp(date)
      if (timestamp) attributes[key] = timestamp
    }
    if (job.createdAt instanceof Date && job.completedAt instanceof Date) {
      const duration = job.completedAt.getTime() - job.createdAt.getTime()
      if (Number.isFinite(duration) && duration >= 0) attributes['job.duration_ms'] = String(duration)
    }
  }

  return attributes
}

function isoTimestamp(date?: Date | null): string | undefined {
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}
