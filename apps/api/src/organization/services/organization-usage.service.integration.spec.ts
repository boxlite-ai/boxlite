/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Redis } from 'ioredis'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { OrganizationUsageService } from './organization-usage.service'

// Exercises the real Redis Lua scripts (reserve / rollback / snapshot read /
// pending->current transfer) that a JS unit test cannot. Runs only when a Redis is
// reachable (CI provides a service and sets REDIS_HOST); skipped otherwise.
const describeIfRedis = process.env.REDIS_HOST ? describe : describe.skip

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1'
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379)

const QUOTA = { totalCpuQuota: 10, totalMemoryQuota: 40, totalDiskQuota: 30, totalGpuQuota: 0, maxConcurrentBoxes: 10 }

describeIfRedis('OrganizationUsageService (integration, real Redis)', () => {
  const org = { id: 'org-int-1' } as any
  let redis: Redis
  let service: OrganizationUsageService
  let qb: { getRawOne: jest.Mock } & Record<string, jest.Mock>
  let boxRepository: any
  let quotaRepository: any

  const setDbUsage = (u: Partial<{ cpu: number; memory: number; disk: number; gpu: number; count: number }>) =>
    qb.getRawOne.mockResolvedValue({
      used_cpu: String(u.cpu ?? 0),
      used_memory: String(u.memory ?? 0),
      used_disk: String(u.disk ?? 0),
      used_gpu: String(u.gpu ?? 0),
      used_count: String(u.count ?? 0),
    })

  const pending = (resource: string) => redis.get(`quota:pending:${org.id}:${resource}`)
  const current = (resource: string) => redis.get(`quota:current:${org.id}:${resource}`)

  beforeAll(() => {
    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 2 })
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    await redis.flushall()
    qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(),
    } as any
    boxRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb), findOne: jest.fn().mockResolvedValue(null) }
    quotaRepository = { findOne: jest.fn().mockResolvedValue({ ...QUOTA }) }
    service = new OrganizationUsageService(redis, boxRepository, quotaRepository, new RedisLockProvider(redis))
  })

  it('admits a create within quota and returns the reservation', async () => {
    setDbUsage({ cpu: 6, count: 3 })
    const reservation = await service.validateOrganizationQuotas(org, 2, 4, 10, 0)
    expect(reservation).toEqual({ cpu: 2, memory: 4, disk: 10, gpu: 0, count: 1 })
  })

  it('rejects a create that exceeds cpu quota and rolls the reservation back to zero', async () => {
    setDbUsage({ cpu: 9, count: 3 }) // 9 + 2 = 11 > 10
    await expect(service.validateOrganizationQuotas(org, 2, 4, 10, 0)).rejects.toThrow(/CPU limit/)
    expect(await pending('cpu')).toBe('0')
  })

  it('serializes concurrent reserves: the first takes the last slot, the second is rejected', async () => {
    setDbUsage({ cpu: 8, count: 4 }) // 2 cpu of headroom
    await service.validateOrganizationQuotas(org, 2, 4, 10, 0) // 8 + 2 = 10, ok; pending cpu = 2
    await expect(service.validateOrganizationQuotas(org, 2, 4, 10, 0)).rejects.toThrow(/CPU limit/) // 8 + 4 = 12
    expect(await pending('cpu')).toBe('2') // second rolled back, first still held
  })

  it('transfers a reservation from pending into current when the box is created', async () => {
    setDbUsage({ cpu: 8, count: 4 })
    await service.getBoxUsageOverview(org.id) // populate the current cache from the DB sum
    await service.validateOrganizationQuotas(org, 2, 4, 10, 0)
    expect(await pending('cpu')).toBe('2')

    await service.handleBoxCreated({
      box: { id: 'box-int-1', organizationId: org.id, cpu: 2, mem: 4, disk: 10, gpu: 0 },
    } as any)

    expect(await pending('cpu')).toBe('0') // reservation drawn down
    expect(await current('cpu')).toBe('10') // 8 + 2 realized into current
  })

  it("counts a starting box's own disk exactly once (rejects when it exceeds disk quota)", async () => {
    quotaRepository.findOne.mockResolvedValue({ ...QUOTA, totalDiskQuota: 20 })
    // The stopped box's 25 GiB disk is already in current usage; starting it must
    // keep that disk counted (once), not drop it, so the over-quota start is rejected.
    setDbUsage({ disk: 25 })
    boxRepository.findOne.mockResolvedValue({
      id: 'box-x',
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      cpu: 2,
      mem: 4,
      disk: 25,
      gpu: 0,
    })
    await expect(service.validateOrganizationQuotas(org, 2, 4, 25, 0, 'box-x')).rejects.toThrow(/disk limit/)
    expect(await pending('disk')).toBe('0') // rolled back
  })

  it('admits a start whose box disk fits the quota, counting the disk once', async () => {
    quotaRepository.findOne.mockResolvedValue({ ...QUOTA, totalDiskQuota: 30 })
    setDbUsage({ disk: 25 })
    boxRepository.findOne.mockResolvedValue({
      id: 'box-x',
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
      cpu: 2,
      mem: 4,
      disk: 25,
      gpu: 0,
    })
    const reservation = await service.validateOrganizationQuotas(org, 2, 4, 25, 0, 'box-x')
    expect(reservation.disk).toBe(25) // disk is reserved (net once after exclude subtracts current)
  })
})
