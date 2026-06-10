/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CallHandler, ExecutionContext } from '@nestjs/common'
import { of } from 'rxjs'
import { trace } from '@opentelemetry/api'
import { CustomHeaders } from '../common/constants/header.constants'
import { ObservabilityContextInterceptor } from './observability-context.interceptor'

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getActiveSpan: jest.fn(),
  },
}))

describe('ObservabilityContextInterceptor', () => {
  const getActiveSpan = trace.getActiveSpan as jest.Mock

  afterEach(() => {
    jest.clearAllMocks()
  })

  function httpContext(request: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext
  }

  it('adds allowed resource identifiers and request source to the active span', (done) => {
    const span = { setAttributes: jest.fn() }
    getActiveSpan.mockReturnValue(span)
    const request = {
      params: {
        traceId: 'trace-path-1',
      },
      query: {
        orgId: 'org-query-1',
        userId: 'user-query-1',
        boxId: 'box-query-1',
        runnerId: 'runner-query-1',
        machineId: 'machine-query-1',
        executionId: 'exec-query-1',
        jobId: 'job-query-1',
        requestId: 'req-query-1',
        operationId: 'op-query-1',
        search: 'do not record this',
      },
      get: (name: string) => (name === CustomHeaders.SOURCE.name ? 'agent' : undefined),
    }
    const interceptor = new ObservabilityContextInterceptor()
    const next: CallHandler = { handle: () => of('ok') }

    interceptor.intercept(httpContext(request), next).subscribe({
      next: () => {
        expect(span.setAttributes).toHaveBeenCalledWith({
          'boxlite.trace_id': 'trace-path-1',
          'boxlite.org_id': 'org-query-1',
          'boxlite.user_id': 'user-query-1',
          'boxlite.box_id': 'box-query-1',
          'boxlite.runner_id': 'runner-query-1',
          'boxlite.machine_id': 'machine-query-1',
          'boxlite.execution_id': 'exec-query-1',
          'boxlite.job_id': 'job-query-1',
          'boxlite.request_id': 'req-query-1',
          'boxlite.operation_id': 'op-query-1',
          'boxlite.source': 'agent',
        })
        expect(JSON.stringify(span.setAttributes.mock.calls[0][0])).not.toContain('do not record this')
        done()
      },
      error: done,
    })
  })

  it('maps boxIdOrName route params to box correlation attributes', (done) => {
    const span = { setAttributes: jest.fn() }
    getActiveSpan.mockReturnValue(span)
    const request = {
      params: {
        boxIdOrName: 'box-or-name-1',
      },
      query: {},
      get: () => undefined,
    }
    const interceptor = new ObservabilityContextInterceptor()
    const next: CallHandler = { handle: () => of('ok') }

    interceptor.intercept(httpContext(request), next).subscribe({
      next: () => {
        try {
          expect(span.setAttributes).toHaveBeenCalledWith({
            'boxlite.box_id': 'box-or-name-1',
          })
          done()
        } catch (error) {
          done(error as Error)
        }
      },
      error: done,
    })
  })

  it('falls back to authenticated user context when query identifiers are absent', (done) => {
    const span = { setAttributes: jest.fn() }
    getActiveSpan.mockReturnValue(span)
    const request = {
      params: {},
      query: {},
      user: {
        userId: 'auth-user-1',
        organizationId: 'auth-org-1',
      },
      get: () => undefined,
    }
    const interceptor = new ObservabilityContextInterceptor()
    const next: CallHandler = { handle: () => of('ok') }

    interceptor.intercept(httpContext(request), next).subscribe({
      next: () => {
        expect(span.setAttributes).toHaveBeenCalledWith({
          'boxlite.user_id': 'auth-user-1',
          'boxlite.org_id': 'auth-org-1',
        })
        done()
      },
      error: done,
    })
  })

  it('does nothing when no active span is available', (done) => {
    getActiveSpan.mockReturnValue(undefined)
    const interceptor = new ObservabilityContextInterceptor()
    const next: CallHandler = { handle: () => of('ok') }

    interceptor.intercept(httpContext({ params: { boxId: 'box-1' } }), next).subscribe({
      next: (value) => {
        expect(value).toBe('ok')
        done()
      },
      error: done,
    })
  })
})
