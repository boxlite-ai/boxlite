/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { BoxAdmissionReservation, BoxAdmissionReservationService } from './box-admission-reservation.service'

const describeIfRedis = process.env.REDIS_HOST ? describe : describe.skip

describeIfRedis('BoxAdmissionReservationService (integration, real Redis)', () => {
  let redis: Redis
  let service: BoxAdmissionReservationService
  let organizationId: string
  let key: string
  let reservations: BoxAdmissionReservation[]

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      maxRetriesPerRequest: 2,
    })
    service = new BoxAdmissionReservationService(redis)
  })

  afterAll(async () => {
    await redis?.quit()
  })

  beforeEach(async () => {
    organizationId = randomUUID()
    key = `box-create-reservations:{${organizationId}}`
    reservations = []
    await redis.del(key)
  })

  afterEach(async () => {
    await Promise.all(reservations.map((reservation) => reservation.release().catch(() => undefined)))
    await redis.del(key)
  })

  it('atomically assigns distinct pending counts to concurrent requests', async () => {
    reservations = await Promise.all([service.reserve(organizationId), service.reserve(organizationId)])

    expect(reservations.map((reservation) => reservation.pendingCount).sort()).toEqual([1, 2])
  })

  it('releases a failed creation immediately instead of waiting for TTL', async () => {
    const failed = await service.reserve(organizationId)
    await failed.release()

    const replacement = await service.reserve(organizationId)
    reservations = [replacement]

    expect(replacement.pendingCount).toBe(1)
  })

  it('prunes expired request tokens during the next reservation', async () => {
    await redis.zadd(key, 0, 'expired-token')

    const reservation = await service.reserve(organizationId)
    reservations = [reservation]

    expect(reservation.pendingCount).toBe(1)
    expect(await redis.zscore(key, 'expired-token')).toBeNull()
  })
})
