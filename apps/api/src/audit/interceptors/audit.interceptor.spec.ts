/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { firstValueFrom, of } from 'rxjs'
import { AuditContext } from '../decorators/audit.decorator'
import { AuditAction } from '../enums/audit-action.enum'
import { AuditTarget } from '../enums/audit-target.enum'
import { AuditInterceptor } from './audit.interceptor'
import { CustomHeaders } from '../../common/constants/header.constants'

jest.mock('uuid', () => ({ v4: () => 'uuid-test' }))

describe('AuditInterceptor', () => {
  it('records the BoxLite source header and structured metadata for audited admin reads', async () => {
    const auditContext: AuditContext = {
      action: AuditAction.READ,
      targetType: AuditTarget.OBSERVABILITY,
      targetIdFromRequest: (req) => `traceId:${req.query.traceId}`,
      requestMetadata: {
        surface: () => 'admin_observability',
        query: (req) => ({ traceId: req.query.traceId }),
      },
    }
    const reflector = {
      get: jest.fn().mockReturnValue(auditContext),
    } as unknown as Reflector
    const auditService = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      updateLog: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    }
    const configService = { get: jest.fn() }
    const interceptor = new AuditInterceptor(reflector, auditService as any, configService as any)
    const request = {
      url: '/admin/observability/investigate?traceId=trace-1',
      ip: '127.0.0.1',
      query: { traceId: 'trace-1' },
      user: { userId: 'user-1', email: 'admin@example.com', organizationId: 'org-1' },
      get: jest.fn((name: string) => {
        if (name === CustomHeaders.SOURCE.name) return 'agent'
        if (name === 'user-agent') return 'boxlite-agent-test'
        return undefined
      }),
    }
    const response = { statusCode: 200 }
    const executionContext = {
      getHandler: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext
    const next = {
      handle: jest.fn().mockReturnValue(of({ organizationId: 'org-1' })),
    } as unknown as CallHandler

    await expect(firstValueFrom(interceptor.intercept(executionContext, next))).resolves.toEqual({
      organizationId: 'org-1',
    })

    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-1',
        actorEmail: 'admin@example.com',
        organizationId: 'org-1',
        action: AuditAction.READ,
        targetType: AuditTarget.OBSERVABILITY,
        targetId: 'traceId:trace-1',
        source: 'agent',
        userAgent: 'boxlite-agent-test',
        metadata: {
          surface: 'admin_observability',
          query: { traceId: 'trace-1' },
        },
      }),
    )
    expect(auditService.updateLog).toHaveBeenCalledWith('audit-1', {
      organizationId: 'org-1',
      targetId: 'traceId:trace-1',
      statusCode: 200,
    })
  })
})
