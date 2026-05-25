/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { Reflector } from '@nestjs/core'
import { AdminTelemetryController } from './telemetry.controller'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'

describe('AdminTelemetryController', () => {
  function buildController() {
    const telemetryService = {
      getPlatformLogs: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
      getPlatformTraces: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
      getPlatformTraceSpans: jest.fn().mockResolvedValue([]),
      getPlatformMetrics: jest.fn().mockResolvedValue({ series: [] }),
    }

    return {
      telemetryService,
      controller: new AdminTelemetryController(telemetryService as any),
    }
  }

  it('is guarded by system admin auth and not sandbox org access', () => {
    const reflector = new Reflector()
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminTelemetryController) ?? []
    const guardNames = guards.map((guard: { name?: string }) => guard.name)

    expect(guards).toEqual([CombinedAuthGuard, SystemActionGuard])
    expect(guardNames).not.toContain('SandboxAccessGuard')
    expect(reflector.get(RequiredApiRole, AdminTelemetryController)).toEqual([SystemRole.ADMIN])
  })

  it('reads platform logs without requiring a sandbox id', async () => {
    const { controller, telemetryService } = buildController()

    await controller.getPlatformLogs({
      from: '2026-05-25T00:00:00.000Z',
      to: '2026-05-25T01:00:00.000Z',
      page: 2,
      limit: 25,
      severities: ['ERROR'],
      search: 'databaseName',
    })

    expect(telemetryService.getPlatformLogs).toHaveBeenCalledWith(
      '2026-05-25T00:00:00.000Z',
      '2026-05-25T01:00:00.000Z',
      2,
      25,
      ['ERROR'],
      'databaseName',
    )
  })

  it('reads platform trace spans without requiring a sandbox id', async () => {
    const { controller, telemetryService } = buildController()

    await controller.getPlatformTraceSpans('trace-1')

    expect(telemetryService.getPlatformTraceSpans).toHaveBeenCalledWith('trace-1')
  })
})
