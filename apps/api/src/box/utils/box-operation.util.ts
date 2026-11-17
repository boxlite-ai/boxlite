/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException } from '@nestjs/common'
import { v4 } from 'uuid'
import { Context } from '../../common/context/context'
import { BusinessEventName, BusinessEventOperation, recordBusinessEvent } from '../../common/utils/business-event.util'
import { BoxReadinessError } from '../errors/box-readiness.error'

type Completion = { boxId?: string } & (
  | { outcome: 'success' }
  | { outcome: 'exception'; error: unknown }
  | { outcome: 'cancelled' }
)

/** One server-side attempt, independent of resource identity and runner-job retries. */
export function beginBoxOperation(options: {
  kind: 'create' | 'start' | 'resume'
  organizationId: string
  ctx: Context
  scope: BusinessEventOperation['scope']
  boxId?: string
  timing?: { requestedAt: Date; monotonicStart: number }
}): (completion: Completion) => void {
  const operation = {
    id: v4(),
    requestedAt: options.timing?.requestedAt ?? new Date(),
    scope: options.scope,
    boxId: options.boxId,
  }
  const started = options.timing?.monotonicStart ?? performance.now()
  const event = {
    name: ('cloud.box.' + options.kind) as BusinessEventName,
    correlationId: operation.id,
    organizationId: options.organizationId,
    ctx: options.ctx,
  }
  recordBusinessEvent({ ...event, operation, occurredAt: operation.requestedAt, outcome: 'requested' })
  let finished = false
  return (completion) => {
    if (finished) return
    finished = true
    const result = completion.outcome === 'exception' ? failureResult(completion.error) : completion.outcome
    const timing: BusinessEventOperation = {
      ...operation,
      boxId: completion.boxId ?? operation.boxId,
      durationMs: Math.max(0, performance.now() - started),
      result,
    }
    recordBusinessEvent({
      ...event,
      operation: timing,
      ...(completion.outcome === 'success' ? { outcome: 'success' } : { outcome: 'exception', exceptionType: result }),
    })
  }
}

function failureResult(error: unknown): 'service_error' | 'timeout' | 'user_error' {
  if (error instanceof BoxReadinessError) return 'service_error'
  const status = error instanceof HttpException ? error.getStatus() : 500
  if (status === 408 || status === 504) return 'timeout'
  return status >= 400 && status < 500 ? 'user_error' : 'service_error'
}
