/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, ServiceUnavailableException } from '@nestjs/common'
import { BoxInventoryLimitExceededError } from '../../box/errors/box-inventory-limit-exceeded.error'
import { RestBoxCreationService } from './rest-box-creation.service'

function makeReservation(pendingCount = 1) {
  return {
    pendingCount,
    signal: new AbortController().signal,
    release: jest.fn().mockResolvedValue(undefined),
  }
}

function makeService(params?: { count?: number; limit?: number | null }) {
  const count = params?.count ?? 0
  const limit = params?.limit === undefined ? 20 : params.limit
  const reservation = makeReservation()
  const limitService = {
    resolveLimit: jest
      .fn()
      .mockResolvedValue(limit === null ? { kind: 'unlimited' } : { kind: 'limited', value: limit }),
  }
  const boxRepository = { countQuotaBoxes: jest.fn().mockResolvedValue(count) }
  const boxService = { create: jest.fn().mockResolvedValue({ id: 'box-1' }) }
  const reservationService = { reserve: jest.fn().mockResolvedValue(reservation) }
  const service = new RestBoxCreationService(
    limitService as any,
    boxRepository as any,
    boxService as any,
    reservationService as any,
  )
  return { service, limitService, boxRepository, boxService, reservationService, reservation }
}

describe('RestBoxCreationService', () => {
  it('rejects create with 403 when the organization is already at its limit', async () => {
    const { service, boxService, reservation } = makeService({ count: 20, limit: 20 })

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
    expect(reservation.release).toHaveBeenCalled()
  })

  it('reserves before counting and creates with a commit-time inventory guard', async () => {
    const { service, boxRepository, boxService, reservationService, reservation } = makeService({
      count: 19,
      limit: 20,
    })
    const dto = {} as any
    const organization = { id: 'org-1' } as any

    await expect(service.create(dto, organization)).resolves.toEqual({ id: 'box-1' })
    expect(reservationService.reserve).toHaveBeenCalledWith('org-1')
    expect(reservationService.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      boxRepository.countQuotaBoxes.mock.invocationCallOrder[0],
    )
    expect(boxService.create).toHaveBeenCalledWith(dto, organization, {
      inventoryLimit: 20,
      signal: reservation.signal,
    })
    expect(reservation.release).toHaveBeenCalled()
  })

  it('skips the count and reservation when Commerce resolves unlimited', async () => {
    const { service, boxRepository, boxService, reservationService } = makeService({ limit: null })

    await service.create({} as any, { id: 'org-1' } as any)

    expect(reservationService.reserve).not.toHaveBeenCalled()
    expect(boxRepository.countQuotaBoxes).not.toHaveBeenCalled()
    expect(boxService.create).toHaveBeenCalled()
  })

  it('fails closed with 503 when a reservation cannot be created', async () => {
    const { service, reservationService, boxRepository, boxService } = makeService()
    reservationService.reserve.mockRejectedValue(new Error('Redis unavailable'))

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

  it('rejects the excess reservation without waiting for another create to finish', async () => {
    const { service, boxRepository, boxService, reservationService } = makeService({ count: 19, limit: 20 })
    const firstReservation = makeReservation(1)
    const secondReservation = makeReservation(2)
    reservationService.reserve.mockResolvedValueOnce(firstReservation).mockResolvedValueOnce(secondReservation)
    boxRepository.countQuotaBoxes.mockResolvedValue(19)

    let finishFirst!: (box: { id: string }) => void
    const firstCreate = new Promise<{ id: string }>((resolve) => {
      finishFirst = resolve
    })
    boxService.create.mockReturnValueOnce(firstCreate)

    let firstSettled = false
    let secondSettled = false
    const first = service.create({ name: 'first' } as any, { id: 'org-1' } as any).finally(() => {
      firstSettled = true
    })
    const second = service.create({ name: 'second' } as any, { id: 'org-1' } as any).finally(() => {
      secondSettled = true
    })
    void second.catch(() => undefined)

    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(boxService.create).toHaveBeenCalledTimes(1)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(true)
    expect(secondReservation.release).toHaveBeenCalled()

    finishFirst({ id: 'box-1' })
    const results = await Promise.allSettled([first, second])

    expect(results[0]).toEqual({ status: 'fulfilled', value: { id: 'box-1' } })
    expect(results[1].status).toBe('rejected')
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(HttpException)
    expect(boxRepository.countQuotaBoxes).toHaveBeenCalledTimes(2)
    expect(firstReservation.release).toHaveBeenCalled()
  })

  it('releases the reservation immediately when creation fails', async () => {
    const { service, boxService, reservation } = makeService({ count: 0, limit: 20 })
    const creationError = new Error('runner unavailable')
    boxService.create.mockRejectedValue(creationError)

    await expect(service.create({} as any, { id: 'org-1' } as any)).rejects.toBe(creationError)
    expect(reservation.release).toHaveBeenCalled()
  })

  it('maps a commit-time inventory race loss to the quota response', async () => {
    const { service, boxService, reservation } = makeService({ count: 19, limit: 20 })
    boxService.create.mockRejectedValue(new BoxInventoryLimitExceededError(20, 20))

    const error = await service.create({} as any, { id: 'org-1' } as any).catch((caught) => caught)

    expect(error).toBeInstanceOf(HttpException)
    expect(error.getStatus()).toBe(403)
    expect(error.getResponse()).toMatchObject({ code: 'resource_exhausted' })
    expect(reservation.release).toHaveBeenCalled()
  })

  it('fails closed with 503 when the reservation is lost before commit', async () => {
    const { service, boxService, reservation } = makeService({ count: 0, limit: 20 })
    const controller = new AbortController()
    reservation.signal = controller.signal
    boxService.create.mockImplementation(async () => {
      controller.abort(new Error('reservation lost'))
      controller.signal.throwIfAborted()
    })

    const error = await service.create({} as any, { id: 'org-1' } as any).catch((caught) => caught)

    expect(error).toBeInstanceOf(ServiceUnavailableException)
    expect(error.getStatus()).toBe(503)
    expect(reservation.release).toHaveBeenCalled()
  })

  it('returns a committed box when reservation release reports ownership loss', async () => {
    const { service, reservation } = makeService({ count: 0, limit: 20 })
    reservation.release.mockRejectedValue(new Error('reservation lost'))

    await expect(service.create({} as any, { id: 'org-1' } as any)).resolves.toEqual({ id: 'box-1' })
  })
})
