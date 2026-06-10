/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common'
import { trace, Attributes } from '@opentelemetry/api'
import { Observable } from 'rxjs'
import { Request } from 'express'
import { CustomHeaders } from '../common/constants/header.constants'

type RequestWithContext = Request & {
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  user?: {
    userId?: unknown
    organizationId?: unknown
  }
}

const REQUEST_ATTRIBUTE_KEYS: Array<{ keys: string[]; attribute: string }> = [
  { keys: ['traceId'], attribute: 'boxlite.trace_id' },
  { keys: ['orgId', 'organizationId'], attribute: 'boxlite.org_id' },
  { keys: ['userId'], attribute: 'boxlite.user_id' },
  { keys: ['boxId', 'boxIdOrName'], attribute: 'boxlite.box_id' },
  { keys: ['runnerId'], attribute: 'boxlite.runner_id' },
  { keys: ['machineId'], attribute: 'boxlite.machine_id' },
  { keys: ['executionId'], attribute: 'boxlite.execution_id' },
  { keys: ['jobId'], attribute: 'boxlite.job_id' },
  { keys: ['requestId'], attribute: 'boxlite.request_id' },
  { keys: ['operationId'], attribute: 'boxlite.operation_id' },
]

@Injectable()
export class ObservabilityContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const span = trace.getActiveSpan()
    if (!span) {
      return next.handle()
    }

    const request = context.switchToHttp().getRequest<RequestWithContext>()
    const attributes = this.buildAttributes(request)
    if (Object.keys(attributes).length > 0) {
      span.setAttributes(attributes)
    }

    return next.handle()
  }

  private buildAttributes(request: RequestWithContext): Attributes {
    const attributes: Attributes = {}
    const params = request.params ?? {}
    const query = request.query ?? {}

    for (const { keys, attribute } of REQUEST_ATTRIBUTE_KEYS) {
      const value = this.firstDefinedValue(keys, params) ?? this.firstDefinedValue(keys, query)
      if (value) {
        attributes[attribute] = value
      }
    }

    const authenticatedUserId = this.firstString(request.user?.userId)
    if (!attributes['boxlite.user_id'] && authenticatedUserId) {
      attributes['boxlite.user_id'] = authenticatedUserId
    }
    const authenticatedOrgId = this.firstString(request.user?.organizationId)
    if (!attributes['boxlite.org_id'] && authenticatedOrgId) {
      attributes['boxlite.org_id'] = authenticatedOrgId
    }

    const source = this.firstString(request.get?.(CustomHeaders.SOURCE.name))
    if (source) {
      attributes['boxlite.source'] = source
    }

    return attributes
  }

  private firstDefinedValue(keys: string[], values: Record<string, unknown>): string | undefined {
    for (const key of keys) {
      const value = this.firstString(values[key])
      if (value) {
        return value
      }
    }
    return undefined
  }

  private firstString(value: unknown): string | undefined {
    const resolved = Array.isArray(value) ? value[0] : value
    if (typeof resolved !== 'string') {
      return undefined
    }
    const trimmed = resolved.trim()
    return trimmed || undefined
  }
}
