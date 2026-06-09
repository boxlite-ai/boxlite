/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { AUDIT_CONTEXT_KEY, AuditContext } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { AdminObservabilityController } from './observability.controller'

describe('AdminObservabilityController audit metadata', () => {
  function auditContext(methodName: keyof AdminObservabilityController): AuditContext {
    return Reflect.getMetadata(AUDIT_CONTEXT_KEY, AdminObservabilityController.prototype[methodName])
  }

  it('audits investigate with a scoped target id and sanitized query metadata', () => {
    const context = auditContext('investigate')
    const request = {
      query: {
        traceId: 'trace-1',
        boxId: 'box-1',
        runnerId: 'runner-1',
        from: '2026-06-05T00:00:00.000Z',
        to: '2026-06-05T01:00:00.000Z',
        search: 'secret token',
      },
    } as unknown as Request

    expect(context).toMatchObject({
      action: AuditAction.READ,
      targetType: AuditTarget.OBSERVABILITY,
    })
    expect(context.targetIdFromRequest?.(request)).toBe('traceId:trace-1')
    expect(context.requestMetadata?.surface(request)).toBe('admin_observability')
    expect(context.requestMetadata?.query(request)).toEqual({
      traceId: 'trace-1',
      boxId: 'box-1',
      runnerId: 'runner-1',
      from: '2026-06-05T00:00:00.000Z',
      to: '2026-06-05T01:00:00.000Z',
      search: { present: true, length: 12 },
    })
  })

  it('audits trace span detail reads with the path trace id', () => {
    const context = auditContext('getTraceSpans')
    const request = {
      params: { traceId: 'trace-path-1' },
      query: { boxId: 'box-1' },
    } as unknown as Request

    expect(context.targetIdFromRequest?.(request)).toBe('traceId:trace-path-1')
    expect(context.requestMetadata?.query(request)).toEqual({ boxId: 'box-1' })
  })
})

describe('AdminObservabilityController access control', () => {
  it('requires authenticated Admin API access for all observability endpoints', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminObservabilityController)
    const requiredApiRoles = Reflect.getMetadata(RequiredApiRole.KEY, AdminObservabilityController)

    expect(guards).toEqual([CombinedAuthGuard, SystemActionGuard])
    expect(requiredApiRoles).toEqual([SystemRole.ADMIN])
  })
})
