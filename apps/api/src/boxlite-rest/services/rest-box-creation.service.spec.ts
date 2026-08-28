/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, ServiceUnavailableException } from '@nestjs/common'
import { RestBoxCreationService } from './rest-box-creation.service'

function makeService(params?: { count?: number; limit?: number | null }) {
  const count = params?.count ?? 0
  const limit = params?.limit === undefined ? 20 : params.limit
  const lease = {
    signal: new AbortController().signal,
    release: jest.fn().mockResolvedValue(undefined),
  }
  const limitService = {
    resolveLimit: jest
      .fn()
      .mockResolvedValue(limit === null ? { kind: 'unlimited' } : { kind: 'limited', value: limit }),
  }
  const boxRepository = { countQuotaBoxes: jest.fn().mockResolvedValue(count) }
  const boxService = { create: jest.fn().mockResolvedValue({ id: 'box-1' }) }
  const redisLockProvider = { waitForLease: jest.fn().mockResolvedValue(lease) }
  const service = new RestBoxCreationService(
    limitService as any,
    boxRepository as any,
    boxService as any,
    redisLockProvider as any,
  )
  return { service, limitService, boxRepository, boxService, redisLockProvider, lease }
}

describe('RestBoxCreationService', () => {
  it('rejects create with 403 when the organization is already at its limit', async () => {
    const { service, boxService, lease } = makeService({ count: 20, limit: 20 })

    const error = await service.create({} as any, { id: 'org-1' } as any).then(
      () => null,
      (caught: HttpException) => caught,
    )

    expect(error).toBeInstanceOf(HttpException)
    if (!error) throw new Error('Expected box creation to be rejected')
    expect(error.getStatus()).toBe(403)
    expect(error.getResponse()).toEqual({
      message:
        'You have already created 20 boxes, reaching or exceeding the current maximum allowed number of 20. Please delete unused boxes and try again.',
      code: 'resource_exhausted',
    })
    expect(boxService.create).not.toHaveBeenCalled()
    expect(lease.release).toHaveBeenCalled()
  })

  it('counts and creates under the same organization lease', async () => {
    const { service, boxRepository, boxService, redisLockProvider, lease } = makeService({ count: 19, limit: 20 })
    const dto = {} as any
    const organization = { id: 'org-1' } as any

    await expect(service.create(dto, organization)).resolves.toEqual({ id: 'box-1' })
    expect(redisLockProvider.waitForLease).toHaveBeenCalledWith(
      'box-create-admission:org-1',
      30,
      expect.any(AbortSignal),
    )
    expect(boxRepository.countQuotaBoxes.mock.invocationCallOrder[0]).toBeLessThan(
      boxService.create.mock.invocationCallOrder[0],
    )
    expect(boxService.create).toHaveBeenCalledWith(dto, organization)
    expect(lease.release).toHaveBeenCalled()
  })

  it('skips the count and lease when Commerce resolves unlimited', async () => {
    const { service, boxRepository, boxService, redisLockProvider } = makeService({ limit: null })

    await service.create({} as any, { id: 'org-1' } as any)

    expect(redisLockProvider.waitForLease).not.toHaveBeenCalled()
    expect(boxRepository.countQuotaBoxes).not.toHaveBeenCalled()
    expect(boxService.create).toHaveBeenCalled()
  })

  it('fails closed with 503 when the admission lease cannot be acquired', async () => {
    const { service, redisLockProvider, boxRepository, boxService } = makeService()
    redisLockProvider.waitForLease.mockRejectedValue(new Error('Redis unavailable'))

    const error = await service.create({} as any, { id: 'org-1' } as any).then(
      () => null,
      (caught: ServiceUnavailableException) => caught,
    )

    expect(error).toBeInstanceOf(ServiceUnavailableException)
    if (!error) throw new Error('Expected box creation to be rejected')
    expect(error.getStatus()).toBe(503)
    expect(error.getResponse()).toEqual({
      message: 'Box creation admission is temporarily unavailable. Please try again.',
      code: 'upstream_unavailable',
    })
    expect(boxRepository.countQuotaBoxes).not.toHaveBeenCalled()
    expect(boxService.create).not.toHaveBeenCalled()
  })

  it('serializes concurrent creates so the second request observes the first commit', async () => {
    const { service, boxRepository, boxService, redisLockProvider } = makeService({ count: 19, limit: 20 })
    let currentBoxCount = 19
    let grantSecondLease!: (lease: any) => void
    const secondLease = {
      signal: new AbortController().signal,
      release: jest.fn().mockResolvedValue(undefined),
    }
    const firstLease = {
      signal: new AbortController().signal,
      release: jest.fn().mockImplementation(async () => grantSecondLease(secondLease)),
    }
    const secondAdmission = new Promise((resolve) => {
      grantSecondLease = resolve
    })
    redisLockProvider.waitForLease
      .mockResolvedValueOnce(firstLease)
      .mockReturnValueOnce(secondAdmission)
    boxRepository.countQuotaBoxes.mockImplementation(async () => currentBoxCount)
    boxService.create.mockImplementation(async () => {
      currentBoxCount += 1
      return { id: 'box-1' }
    })

    const results = await Promise.allSettled([
      service.create({} as any, { id: 'org-1' } as any),
      service.create({} as any, { id: 'org-1' } as any),
    ])

    expect(results[0]).toEqual({ status: 'fulfilled', value: { id: 'box-1' } })
    expect(results[1].status).toBe('rejected')
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(HttpException)
    expect(boxRepository.countQuotaBoxes).toHaveBeenCalledTimes(2)
    expect(boxService.create).toHaveBeenCalledTimes(1)
  })
})
