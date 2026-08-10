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
  // The context below is synthetic on purpose: since the admin observability
  // controller was deleted, no route emits AuditAction.READ. Metadata keys are
  // resolved generically (resolveRequestMetadata iterates the extractors), so
  // `surface`/`query` cover nothing the production `body:` extractors miss —
  // what this uniquely holds is READ and a composite targetIdFromRequest.
  it('records the BoxLite source header and structured metadata for an audited request', async () => {
    const auditContext: AuditContext = {
      action: AuditAction.READ,
      targetType: AuditTarget.RUNNER,
      targetIdFromRequest: (req) => `regionId:${req.query.regionId}`,
      requestMetadata: {
        surface: () => 'admin_runners',
        query: (req) => ({ regionId: req.query.regionId }),
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
      url: '/admin/runners?regionId=region-1',
      ip: '127.0.0.1',
      query: { regionId: 'region-1' },
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
        targetType: AuditTarget.RUNNER,
        targetId: 'regionId:region-1',
        source: 'agent',
        userAgent: 'boxlite-agent-test',
        metadata: {
          surface: 'admin_runners',
          query: { regionId: 'region-1' },
        },
      }),
    )
    expect(auditService.updateLog).toHaveBeenCalledWith('audit-1', {
      organizationId: 'org-1',
      targetId: 'regionId:region-1',
      statusCode: 200,
    })
  })

  // A caller authenticated through a system API key (billing, proxy, ...) has
  // no userId — only a role. AuditLog.actorId is NOT NULL with no default, so
  // passing that undefined userId through crashed the insert and turned every
  // audited action such a caller reached into a 500 before the handler ran.
  it('audits an API-key-role caller (no userId) without crashing', async () => {
    const auditContext: AuditContext = {
      action: AuditAction.SUSPEND,
      targetType: AuditTarget.ORGANIZATION,
      targetIdFromRequest: (req) => req.params.organizationId,
    }
    const reflector = { get: jest.fn().mockReturnValue(auditContext) } as unknown as Reflector
    const auditService = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit-2' }),
      updateLog: jest.fn().mockResolvedValue({ id: 'audit-2' }),
    }
    const configService = { get: jest.fn() }
    const interceptor = new AuditInterceptor(reflector, auditService as any, configService as any)
    const request = {
      url: '/organizations/org-1/suspend',
      ip: '127.0.0.1',
      params: { organizationId: 'org-1' },
      user: { role: 'billing' },
      get: jest.fn().mockReturnValue(undefined),
    }
    const response = { statusCode: 204 }
    const executionContext = {
      getHandler: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext
    const next = { handle: jest.fn().mockReturnValue(of(undefined)) } as unknown as CallHandler

    await expect(firstValueFrom(interceptor.intercept(executionContext, next))).resolves.toBeUndefined()

    expect(auditService.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'api-role:billing',
        actorEmail: '',
        organizationId: undefined,
      }),
    )
  })
})
