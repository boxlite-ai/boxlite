/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AdminRunnerController } from './runner.controller'
import { ValidationPipe } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { RequestMethod } from '@nestjs/common'
import { RequiredApiRole } from '../../common/decorators/required-role.decorator'
import { SystemRole } from '../../user/enums/system-role.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { SystemActionGuard } from '../../auth/system-action.guard'
import { AUDIT_CONTEXT_KEY } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { UpdateRunnerDrainingDto } from '../../box/dto/runner-draining.dto'

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'uuid-test'),
  validate: jest.fn(() => true),
}))

describe('AdminRunnerController', () => {
  function buildController() {
    const runnerService = {
      updateDrainingStatus: jest.fn().mockResolvedValue({ apiKey: 'secret' }),
      getDrainStatus: jest
        .fn()
        .mockResolvedValue({ id: 'runner-1', draining: true, assignedBoxes: 0, activeMigrations: 1, pendingJobs: 1 }),
      findOneFullOrFail: jest.fn().mockResolvedValue({
        id: 'runner-1',
        state: 'ready',
        apiKey: 'runner-secret-key',
      }),
      findAllFull: jest.fn().mockResolvedValue([
        {
          id: 'runner-1',
          state: 'ready',
          apiKey: 'runner-secret-key',
        },
      ]),
      findAllByRegionFull: jest.fn().mockResolvedValue([
        {
          id: 'runner-1',
          state: 'ready',
          apiKey: 'runner-secret-key',
        },
      ]),
    }
    const regionService = {
      findOne: jest.fn(),
    }

    return {
      runnerService,
      controller: new AdminRunnerController(runnerService as any, regionService as any),
    }
  }

  it('redacts runner api keys from list and detail responses', async () => {
    const { controller } = buildController()

    const detail = await controller.getRunnerById('00000000-0000-4000-8000-000000000000')
    const list = await controller.findAll()
    const regionalList = await controller.findAll('us')

    expect(detail).not.toHaveProperty('apiKey')
    expect(list[0]).not.toHaveProperty('apiKey')
    expect(regionalList[0]).not.toHaveProperty('apiKey')
    expect(JSON.stringify({ detail, list, regionalList })).not.toContain('runner-secret-key')
  })

  it('exposes drain routes only behind the administrator guards and audits mutations', () => {
    expect(Reflect.getMetadata(RequiredApiRole.KEY, AdminRunnerController)).toEqual([SystemRole.ADMIN])
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminRunnerController)).toEqual([CombinedAuthGuard, SystemActionGuard])
    for (const [method, verb] of [
      [AdminRunnerController.prototype.getDrainStatus, RequestMethod.GET],
      [AdminRunnerController.prototype.updateDrainingStatus, RequestMethod.PATCH],
    ] as const) {
      expect(Reflect.getMetadata(PATH_METADATA, method)).toBe(':id/draining')
      expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(verb)
    }
    expect(Reflect.getMetadata(AUDIT_CONTEXT_KEY, AdminRunnerController.prototype.updateDrainingStatus).action).toBe(
      AuditAction.UPDATE_DRAINING,
    )
    expect(Reflect.getMetadata('design:paramtypes', AdminRunnerController.prototype, 'updateDrainingStatus')[1]).toBe(
      UpdateRunnerDrainingDto,
    )
  })

  it('validates drain booleans and forwards progress without returning mutation credentials', async () => {
    const { controller, runnerService } = buildController()
    const pipe = new ValidationPipe({ transform: true })
    const metadata = { type: 'body' as const, metatype: UpdateRunnerDrainingDto }
    for (const draining of ['false', 1, null, undefined]) {
      await expect(pipe.transform({ draining }, metadata)).rejects.toMatchObject({ status: 400 })
    }
    for (const draining of [true, false]) {
      const body = await pipe.transform({ draining }, metadata)
      expect(await controller.updateDrainingStatus('runner-1', body)).toBeUndefined()
      expect(runnerService.updateDrainingStatus).toHaveBeenLastCalledWith('runner-1', draining)
    }
    expect(await controller.getDrainStatus('runner-1')).toEqual(await runnerService.getDrainStatus())
    expect(runnerService.getDrainStatus).toHaveBeenCalledWith('runner-1')
  })
})
