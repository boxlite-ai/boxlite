/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AuditService } from './audit.service'

describe('AuditService cleanup cancellation', () => {
  const makeService = (deleteLogs: jest.Mock, controller = new AbortController()) => {
    const service = Object.create(AuditService.prototype) as AuditService
    Object.assign(service as any, {
      auditLogRepository: { delete: deleteLogs },
      configService: { get: jest.fn().mockReturnValue(1) },
      redisLockProvider: {
        acquireLease: jest.fn().mockResolvedValue({
          signal: controller.signal,
          release: jest.fn().mockResolvedValue(undefined),
        }),
      },
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
      controller,
    )

    await expect(service.cleanupOldAuditLogs()).rejects.toBe(repositoryError)
  })

  it('rethrows the cancellation reason produced by the signal', async () => {
    const ownershipError = new Error('ownership was lost')
    const controller = new AbortController()
    controller.abort(ownershipError)
    const service = makeService(jest.fn(), controller)

    await expect(service.cleanupOldAuditLogs()).rejects.toBe(ownershipError)
  })
})
