/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ExecutionContext } from '@nestjs/common'
import { trace } from '@opentelemetry/api'
import { of } from 'rxjs'
import { TenantTelemetryInterceptor } from './tenant-telemetry.interceptor'
import { SystemRole } from '../../user/enums/system-role.enum'

describe('TenantTelemetryInterceptor', () => {
  it('stamps authenticated request ownership on the active span and request logger', () => {
    const setAttributes = jest.fn()
    const spanContext = jest.fn(() => ({ traceId: 'a'.repeat(32) }))
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({ setAttributes, spanContext } as never)
    const logger = { assign: jest.fn() }
    const setHeader = jest.fn()
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          user: {
            role: SystemRole.USER,
            organizationId: 'org-a',
            organization: { id: 'org-a' },
            organizationUser: { organizationId: 'org-a' },
          },
          params: { boxId: 'box-a', jobId: 'job-a' },
        }),
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext

    new TenantTelemetryInterceptor(logger as never).intercept(context, { handle: () => of(null) })

    const expected = {
      'boxlite.source': 'api',
      'boxlite.organization.id': 'org-a',
      'boxlite.box.id': 'box-a',
      'boxlite.job.id': 'job-a',
    }
    expect(setAttributes).toHaveBeenCalledWith(expected)
    expect(logger.assign).toHaveBeenCalledWith(expected)
    expect(setHeader).toHaveBeenCalledWith('x-trace-id', 'a'.repeat(32))
  })

  it('does not trust an organization ID copied only from the request header', () => {
    const setAttributes = jest.fn()
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue({
      setAttributes,
      spanContext: () => ({ traceId: 'a'.repeat(32) }),
    } as never)
    const logger = { assign: jest.fn() }
    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({
          user: { role: SystemRole.USER, organizationId: 'victim-org' },
          params: { boxId: 'victim-box' },
        }),
        getResponse: () => ({ setHeader: jest.fn() }),
      }),
    } as unknown as ExecutionContext

    new TenantTelemetryInterceptor(logger as never).intercept(context, { handle: () => of(null) })

    expect(setAttributes).not.toHaveBeenCalled()
    expect(logger.assign).not.toHaveBeenCalled()
  })
})
