/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    isAxiosError: (error: any) => Boolean(error?.isAxiosError),
  },
}))

import axios from 'axios'
import { BoxUsageExportOutbox, UsageExportStatus } from '../entities/box-usage-export-outbox.entity'
import { UsageExportPublisherService } from './usage-export-publisher.service'

const post = axios.post as jest.Mock

const CONFIG: Record<string, unknown> = {
  'usageExport.enabled': true,
  'usageExport.url': 'https://commerce.test',
  'usageExport.token': 'tok-1',
  'usageExport.batchSize': 200,
  'usageExport.timeoutMs': 10_000,
  'usageExport.maxAttempts': 10,
}

const row = (overrides: Partial<BoxUsageExportOutbox> = {}): BoxUsageExportOutbox =>
  ({
    eventKey: 'key-1',
    payload: { eventKey: 'key-1', schemaVersion: 1, cpu: '2' },
    status: UsageExportStatus.PENDING,
    attempts: 1,
    ...overrides,
  }) as BoxUsageExportOutbox

const httpError = (status?: number) => ({
  isAxiosError: true,
  message: status ? `Request failed with status code ${status}` : 'timeout of 10000ms exceeded',
  code: status ? undefined : 'ECONNABORTED',
  response: status ? { status } : undefined,
})

const makeService = (claimed: BoxUsageExportOutbox[], overrides: Record<string, unknown> = {}) => {
  const outboxRepository = {
    query: jest.fn().mockResolvedValue(claimed),
    update: jest.fn().mockResolvedValue({ affected: claimed.length }),
  }
  const outboxService = { pruneDelivered: jest.fn().mockResolvedValue(0) }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
  const configService = {
    get: jest.fn((key: string) => {
      const settings = { ...CONFIG, ...overrides }
      if (!(key in settings)) {
        throw new Error(`usage-export-publisher.service.spec: unexpected config key "${key}"`)
      }
      return settings[key]
    }),
  }

  const service = new UsageExportPublisherService(
    outboxRepository as any,
    outboxService as any,
    redisLockProvider as any,
    configService as any,
  )

  return { service, outboxRepository, outboxService, redisLockProvider }
}

beforeEach(() => {
  post.mockReset()
})

describe('UsageExportPublisherService.publishPendingExports', () => {
  it('does nothing while export is disabled', async () => {
    const { service, outboxRepository } = makeService([row()], { 'usageExport.enabled': false })

    await service.publishPendingExports()

    expect(outboxRepository.query).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('yields to whichever replica holds the lock', async () => {
    const { service, outboxRepository, redisLockProvider } = makeService([row()])
    redisLockProvider.lock.mockResolvedValue(false)

    await service.publishPendingExports()

    expect(outboxRepository.query).not.toHaveBeenCalled()
  })

  it('sends the stored payloads with the service token and timeout', async () => {
    const { service } = makeService([row(), row({ eventKey: 'key-2', payload: { eventKey: 'key-2' } })])
    post.mockResolvedValue({ status: 200, data: { accepted: 2, duplicates: 0 } })

    await service.publishPendingExports()

    expect(post).toHaveBeenCalledWith(
      'https://commerce.test/internal/usage-events',
      { events: [{ eventKey: 'key-1', schemaVersion: 1, cpu: '2' }, { eventKey: 'key-2' }] },
      expect.objectContaining({
        timeout: 10_000,
        headers: expect.objectContaining({ authorization: 'Bearer tok-1' }),
      }),
    )
  })

  it('retires the batch once Commerce accepts it', async () => {
    const { service, outboxRepository } = makeService([row()])
    post.mockResolvedValue({ status: 200, data: { accepted: 1, duplicates: 0 } })

    await service.publishPendingExports()

    expect(outboxRepository.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: UsageExportStatus.DELIVERED, lastError: null }),
    )
  })

  // A transient failure must stay claimable. Marking it anything else would
  // strand usage that was never delivered.
  it.each([
    ['a server error', httpError(503)],
    ['a timeout', httpError()],
  ])('defers the batch after %s', async (_case, error) => {
    const { service, outboxRepository } = makeService([row({ attempts: 2 })])
    post.mockRejectedValue(error)

    await service.publishPendingExports()

    const [, changes] = outboxRepository.update.mock.calls[0]
    expect(changes.status).toBeUndefined()
    expect(changes.availableAt).toBeInstanceOf(Date)
    expect(changes.availableAt.getTime()).toBeGreaterThan(Date.now())
  })

  // A malformed payload is a defect, not a blip: retrying it to the attempt cap
  // only delays every row queued behind it.
  it.each([
    ['a malformed payload', 400],
    ['an unprocessable payload', 422],
  ])('blocks the batch immediately on %s', async (_case, status) => {
    const { service, outboxRepository } = makeService([row()])
    post.mockRejectedValue(httpError(status))

    await service.publishPendingExports()

    expect(outboxRepository.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: UsageExportStatus.BLOCKED }),
    )
  })

  // Nothing returns a blocked row to pending, so blocking on a client error that
  // clears by itself would strand the usage permanently. Each of these happens
  // in normal operation: a rotating token, a receiver not deployed yet, a slow
  // request, a rate limit.
  it.each([
    ['an expired token', 401],
    ['a forbidden response', 403],
    ['a receiver that is not deployed yet', 404],
    ['a request timeout', 408],
    ['a rate limit', 429],
  ])('keeps the batch claimable after %s', async (_case, status) => {
    const { service, outboxRepository } = makeService([row({ attempts: 2 })])
    post.mockRejectedValue(httpError(status))

    await service.publishPendingExports()

    const [, changes] = outboxRepository.update.mock.calls[0]
    expect(changes.status).toBeUndefined()
    expect(changes.availableAt).toBeInstanceOf(Date)
  })

  it('blocks the batch once attempts are exhausted', async () => {
    const { service, outboxRepository } = makeService([row({ attempts: 9 })])
    post.mockRejectedValue(httpError(503))

    await service.publishPendingExports()

    expect(outboxRepository.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: UsageExportStatus.BLOCKED }),
    )
  })

  it('charges exactly one attempt to a failed delivery', async () => {
    const { service, outboxRepository } = makeService([row({ attempts: 3 })])
    post.mockRejectedValue(httpError(503))

    await service.publishPendingExports()

    const [, changes] = outboxRepository.update.mock.calls[0]
    expect(changes.attempts).toBe(4)
  })

  // The batch is whatever the claim scooped up, so deciding for all of it from
  // one row makes a row's fate depend on its neighbours.
  it('judges each row against its own budget, not the batch', async () => {
    const { service, outboxRepository } = makeService([
      row({ eventKey: 'nearly-spent', attempts: 9 }),
      row({ eventKey: 'fresh', attempts: 1 }),
    ])
    post.mockRejectedValue(httpError(503))

    await service.publishPendingExports()

    const updates = outboxRepository.update.mock.calls
    const blocked = updates.find(([, changes]) => changes.status === UsageExportStatus.BLOCKED)
    const deferred = updates.find(([, changes]) => changes.status === undefined)

    expect(blocked?.[0].eventKey._value).toEqual(['nearly-spent'])
    expect(deferred?.[0].eventKey._value).toEqual(['fresh'])
    expect(deferred?.[1].attempts).toBe(2)
  })

  it('releases the lock even when the claim throws', async () => {
    const { service, redisLockProvider, outboxRepository } = makeService([row()])
    outboxRepository.query.mockRejectedValue(new Error('database is down'))

    await expect(service.publishPendingExports()).rejects.toThrow('database is down')
    expect(redisLockProvider.unlock).toHaveBeenCalledWith('publish-usage-exports')
  })
})

// Retention rides the idle branch so the exporter keeps one schedule and one
// lock. Sweeping while there is still a backlog would spend the cycle on
// housekeeping instead of delivery.
describe('UsageExportPublisherService retention', () => {
  it('sweeps delivered history when there is nothing to send', async () => {
    const { service, outboxService } = makeService([])

    await service.publishPendingExports()

    expect(outboxService.pruneDelivered).toHaveBeenCalledWith(30)
    expect(post).not.toHaveBeenCalled()
  })

  it('does not sweep while a batch is still in flight', async () => {
    const { service, outboxService } = makeService([row()])
    post.mockResolvedValue({ status: 200, data: {} })

    await service.publishPendingExports()

    expect(outboxService.pruneDelivered).not.toHaveBeenCalled()
  })

  it('does not sweep while export is disabled', async () => {
    const { service, outboxService } = makeService([], { 'usageExport.enabled': false })

    await service.publishPendingExports()

    expect(outboxService.pruneDelivered).not.toHaveBeenCalled()
  })
})

describe('UsageExportPublisherService claiming', () => {
  // The claim is what stands in for a lease. It has to skip rows another
  // publisher holds and push the batch out of sight for the visibility window,
  // without moving it to a state a crash could strand.
  it('claims with SKIP LOCKED and defers the batch by the visibility window', async () => {
    const { service, outboxRepository } = makeService([row()])
    post.mockResolvedValue({ status: 200, data: {} })

    await service.publishPendingExports()

    const [sql, parameters] = outboxRepository.query.mock.calls[0]
    expect(sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(sql).toContain('"availableAt" = now()')
    // The retry budget is spent by a failed delivery, never by taking the row.
    expect(sql).not.toContain('"attempts"')
    expect(parameters).toEqual([60_000, UsageExportStatus.PENDING, 200])
  })

  it('never moves a claimed row into a state a crash could strand', async () => {
    const { service, outboxRepository } = makeService([row()])
    post.mockResolvedValue({ status: 200, data: {} })

    await service.publishPendingExports()

    const [sql] = outboxRepository.query.mock.calls[0]
    expect(sql).not.toContain('delivering')
  })
})

describe('UsageExportPublisherService backoff', () => {
  const deferralMs = async (attempts: number) => {
    const { service, outboxRepository } = makeService([row({ attempts })])
    post.mockRejectedValue(httpError(503))

    await service.publishPendingExports()

    const [, changes] = outboxRepository.update.mock.calls[0]
    return changes.availableAt.getTime() - Date.now()
  }

  it('backs off further with each attempt', async () => {
    const early = await deferralMs(1)
    const later = await deferralMs(3)

    expect(later).toBeGreaterThan(early)
  })

  // Without a ceiling the doubling would push a row past any plausible
  // retention window and the usage would age out undelivered.
  it('caps the backoff at fifteen minutes', async () => {
    // attempts 8 charges attempt 9, whose uncapped backoff would be 2**8 x 30s
    // = 128 minutes; anything at or below the cap proves the clamp.
    expect(await deferralMs(8)).toBeLessThanOrEqual(15 * 60 * 1000 + 1_000)
  })
})
