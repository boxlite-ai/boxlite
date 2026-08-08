/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AuditService } from './audit.service'

describe('AuditService cleanup cancellation', () => {
  const makeService = (deleteLogs: jest.Mock) => {
    const service = Object.create(AuditService.prototype) as AuditService
    Object.assign(service as any, {
      auditLogRepository: { delete: deleteLogs },
      configService: { get: jest.fn().mockReturnValue(1) },
      logger: { log: jest.fn(), error: jest.fn() },
    })
    return service
  }

  it('preserves a repository failure when cancellation happens concurrently', async () => {
    const repositoryError = new Error('database unavailable')
    const controller = new AbortController()
    const service = makeService(
      jest.fn(async () => {
        controller.abort(new Error('ownership was lost'))
        throw repositoryError
      }),
    )

    await service.cleanupOldAuditLogs(controller.signal)

    expect((service as any).logger.error).toHaveBeenCalledWith(
      expect.stringContaining(repositoryError.message),
      repositoryError.stack,
    )
  })

  it('rethrows the cancellation reason produced by the signal', async () => {
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    controller.abort(ownershipError)
    const service = makeService(jest.fn())

    await expect(service.cleanupOldAuditLogs(controller.signal)).rejects.toBe(ownershipError)
  })
})
