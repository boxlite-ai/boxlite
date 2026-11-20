/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus } from '@nestjs/common'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Redis from 'ioredis'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { IsNull, Repository } from 'typeorm'
import { Organization } from '../../organization/entities/organization.entity'
import { RegistryCredentialService } from '../../registry/services/registry-credential.service'
import { Image } from '../entities/image.entity'
import { ImageCountLimitReachedError } from '../errors/image-admission.error'
import { ImageAdmissionService } from './image-admission.service'
import { ResolvedImage } from './image-resolver.service'

type RedisMock = { eval: jest.Mock }
type ImageRepositoryMock = { exists: jest.Mock; count: jest.Mock }

/** What the resolver answers for a ref the catalog has never seen. */
const CATALOG_MISS: ResolvedImage = { ref: 'quay.io/acme/app:v1', isOrgOwned: true }

describe('ImageAdmissionService', () => {
  const organization = { id: 'org-1', imageCountLimit: 20 } as Organization

  let redis: RedisMock
  let images: ImageRepositoryMock
  let credentials: { routesThroughProxy: jest.Mock }
  let service: ImageAdmissionService

  const build = () =>
    new ImageAdmissionService(
      redis as unknown as Redis,
      images as unknown as Repository<Image>,
      credentials as unknown as RegistryCredentialService,
    )

  beforeEach(() => {
    process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST = 'quay.io,gcr.io'
    redis = {
      eval: jest.fn().mockResolvedValue([1, 'gen-1', 60000]),
    }
    images = {
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
    }
    credentials = { routesThroughProxy: jest.fn().mockResolvedValue(false) }
    service = build()
  })

  afterEach(() => {
    delete process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST
    delete process.env.REGISTRY_PROXY_HOST
  })

  it('admits an allowed registry', async () => {
    await expect(service.assert(organization, 'quay.io/acme/app:v1')).resolves.toBeUndefined()
  })

  it('refuses a registry outside the allowlist', async () => {
    await expect(service.assert(organization, 'evil.example/acme/app:v1')).rejects.toThrow(BadRequestError)
  })

  it('refuses a host that points back inside the deployment', async () => {
    await expect(service.assert(organization, '169.254.169.254/acme/app:v1')).rejects.toThrow(BadRequestError)
  })

  it('refuses a malformed ref', async () => {
    await expect(service.assert(organization, 'quay.io/../etc/passwd')).rejects.toThrow(BadRequestError)
  })

  /**
   * Curated images were already allowed and are operator-chosen, so the gate
   * they predate must not start charging them for it. Checked with a spy rather
   * than by outcome: passing is what a broken gate would also do.
   */
  it('lets a curated selector through without a catalog lookup or budget', async () => {
    for (const selector of [undefined, 'python', 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0']) {
      await service.assert(organization, selector)
    }
    await service.spendColdPullBudget(organization, {
      ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
      isOrgOwned: false,
    })
    expect(images.exists).not.toHaveBeenCalled()
    expect(redis.eval).not.toHaveBeenCalled()
    // Nor asked about logins: a login for the curated image's whole host must
    // not be able to take the curated path over.
    expect(credentials.routesThroughProxy).not.toHaveBeenCalled()
  })

  describe('registered logins', () => {
    const PROXY = '127.0.0.1:4100'

    beforeEach(() => {
      process.env.REGISTRY_PROXY_HOST = PROXY
    })

    it('admits a host off the allowlist when a login covers the repository', async () => {
      credentials.routesThroughProxy.mockResolvedValue(true)

      await expect(service.assert(organization, 'ghcr.io/acme/app:1')).resolves.toBeUndefined()
      expect(credentials.routesThroughProxy).toHaveBeenCalledWith('org-1', 'ghcr.io', 'acme/app')
    })

    it('says a login would open a host that takes one, and where to add it, when none covers the repository', async () => {
      const refused = service.assert(organization, 'ghcr.io/other/app:1')

      await expect(refused).rejects.toThrow(/add one under Registries in the console/)
      await expect(refused).rejects.toThrow(/the SDK's runtime registries handle/)
    })

    it('refuses a ref written against the proxy itself, before anything is looked up', async () => {
      credentials.routesThroughProxy.mockResolvedValue(true)

      await expect(service.assert(organization, `${PROXY}/org-2/ghcr.io/acme/app:1`)).rejects.toThrow(BadRequestError)
      expect(credentials.routesThroughProxy).not.toHaveBeenCalled()
    })

    it('refuses to start when the allowlist names the proxy', () => {
      process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST = `quay.io,${PROXY}`

      expect(build).toThrow(/lists the registry proxy/)
    })
  })

  describe('catalog limit', () => {
    it('admits an image the organization already holds, whatever the count', async () => {
      images.exists.mockResolvedValue(true)
      images.count.mockResolvedValue(999)

      await expect(service.assert(organization, 'quay.io/acme/app:v1')).resolves.toBeUndefined()
    })

    it('refuses a new image once the organization holds its limit', async () => {
      images.count.mockResolvedValue(20)

      const error = await service.assert(organization, 'quay.io/acme/app:v1').catch((e) => e)

      expect(error).toBeInstanceOf(ImageCountLimitReachedError)
      expect(error.getResponse().message).toContain('limit of 20 images')
    })

    it('admits a new image below the limit', async () => {
      images.count.mockResolvedValue(19)

      await expect(service.assert(organization, 'quay.io/acme/app:v1')).resolves.toBeUndefined()
    })

    it('counts and matches only images this organization still holds', async () => {
      await service.assert(organization, 'quay.io/acme/app:v1')

      expect(images.exists).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', name: 'quay.io/acme/app', deletedAt: IsNull() },
      })
      expect(images.count).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', deletedAt: IsNull() },
      })
    })
  })

  describe('pull budget', () => {
    /** A hit is handed out by digest: a build already pulled and booted here. */
    it('spends nothing on a ref the catalog answered', async () => {
      await service.spendColdPullBudget(organization, {
        ref: `quay.io/acme/app@sha256:${'a'.repeat(64)}`,
        isOrgOwned: true,
        imageId: 'image-1',
      })
      expect(redis.eval).not.toHaveBeenCalled()
    })

    it('sets the window on the first pull of a window', async () => {
      await service.spendColdPullBudget(organization, CATALOG_MISS)
      expect(redis.eval.mock.calls[0].slice(1)).toEqual([
        3,
        'image:coldpull:org-1',
        'image:coldpull:org-1:gen',
        'image:coldpull:org-1:genseq',
        60,
        6,
      ])
    })

    it('does not reset the window on later pulls', async () => {
      redis.eval.mockResolvedValue([2, 'gen-1', 59000])
      await service.spendColdPullBudget(organization, CATALOG_MISS)
      expect(redis.eval).toHaveBeenCalledTimes(1)
    })

    /**
     * The filter turns a `retryAfterSeconds` on the exception into the
     * `Retry-After` header, but only for a positive safe integer, so that is
     * the shape this has to produce.
     */
    it('reports how long to wait when the budget is spent', async () => {
      redis.eval.mockResolvedValue([7, 'gen-1', 42000])

      const error = await service.spendColdPullBudget(organization, CATALOG_MISS).catch((e) => e)

      expect(error.status).toBe(HttpStatus.TOO_MANY_REQUESTS)
      expect(Number.isSafeInteger(error.retryAfterSeconds)).toBe(true)
      expect(error.retryAfterSeconds).toBe(42)
    })

    /**
     * The window and the time left in it are different numbers, and the message
     * is the only place an operator sees either. Reading the remaining TTL as
     * the window makes the limit look like it changes size between requests.
     */
    it('names the window length, not the time left in it', async () => {
      redis.eval.mockResolvedValue([7, 'gen-1', 42000])

      const error = await service.spendColdPullBudget(organization, CATALOG_MISS).catch((e) => e)

      expect(error.getResponse().message).toContain('at most 6 of them per 60s window')
      expect(error.getResponse().message).toContain('42s left')
    })

    /**
     * A key that lost its TTL would otherwise block the organization for good,
     * and a negative retry-after would be dropped by the filter, leaving a 429
     * with no guidance at all.
     */
    it('restores the window and still answers when the key has no expiry', async () => {
      redis.eval.mockResolvedValue([7, 'gen-1', -1])

      const error = await service.spendColdPullBudget(organization, CATALOG_MISS).catch((e) => e)

      expect(error.retryAfterSeconds).toBe(60)
    })

    /** Six starts fit in a window by default; the seventh is refused. */
    it('admits six cold pulls a window by default', async () => {
      redis.eval.mockResolvedValue([6, 'gen-1', 60000])
      await expect(service.spendColdPullBudget(organization, CATALOG_MISS)).resolves.toEqual({
        generation: 'gen-1',
        spent: 1,
      })

      redis.eval.mockResolvedValue([7, 'gen-1', 60000])
      await expect(service.spendColdPullBudget(organization, CATALOG_MISS)).rejects.toThrow(/at most 6/)
    })

    describe('generation-bound refunds against Redis', () => {
      let directory: string
      let server: ChildProcess
      let client: Redis
      let live: ImageAdmissionService
      const counter = 'image:coldpull:org-1'
      const generation = counter + ':gen'

      beforeAll(async () => {
        directory = await mkdtemp(join(tmpdir(), 'boxlite-admission-'))
        const socket = join(directory, 'redis.sock')
        server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'])
        server.once('error', (error) => server.stdout!.destroy(error))
        for await (const chunk of server.stdout!) {
          if (chunk.toString().includes('Ready to accept connections')) break
        }
        client = new Redis({ path: socket, lazyConnect: true, maxRetriesPerRequest: 2 })
        await client.connect()
      })

      afterAll(async () => {
        await client?.quit().catch(() => client?.disconnect())
        if (server && server.exitCode === null) {
          const stopped = once(server, 'exit')
          server.kill()
          await stopped
        }
        if (directory) await rm(directory, { recursive: true, force: true })
      })

      beforeEach(async () => {
        await client.flushall()
        live = new ImageAdmissionService(
          client,
          images as unknown as Repository<Image>,
          credentials as unknown as RegistryCredentialService,
        )
      })

      it('refunds concurrent spends per unit without extending either expiry', async () => {
        const tickets = await Promise.all(
          Array.from({ length: 6 }, () => live.spendColdPullBudget(organization, CATALOG_MISS)),
        )
        expect(tickets.every((ticket) => ticket?.spent === 1)).toBe(true)
        await client.pexpire(counter, 10000)
        await client.pexpire(generation, 10000)
        await Promise.all(
          tickets.slice(1).map((ticket) => live.refundColdPullBudget(organization, CATALOG_MISS, ticket!)),
        )
        expect(await client.get(counter)).toBe('1')
        for (const redisKey of [counter, generation]) {
          expect(await client.pttl(redisKey)).toBeGreaterThan(0)
          expect(await client.pttl(redisKey)).toBeLessThanOrEqual(10000)
        }
        await live.refundColdPullBudget(organization, CATALOG_MISS, tickets[0]!)
        expect(await client.get(counter)).toBe('0')
      })

      it('does not resurrect an expired counter or refund its replacement', async () => {
        const stale = (await live.spendColdPullBudget(organization, CATALOG_MISS))!
        await client.pexpire(counter, 0)
        await live.refundColdPullBudget(organization, CATALOG_MISS, stale)
        expect(await client.exists(counter)).toBe(0)
        await client.del(generation)
        const fresh = (await live.spendColdPullBudget(organization, CATALOG_MISS))!
        expect(fresh.generation).not.toBe(stale.generation)
        await live.refundColdPullBudget(organization, CATALOG_MISS, stale)
        expect(await client.get(counter)).toBe('1')
      })
    })

    describe('overridden by the environment', () => {
      afterEach(() => {
        delete process.env.BOXLITE_IMAGE_COLD_PULL_LIMIT
        delete process.env.BOXLITE_IMAGE_COLD_PULL_WINDOW_SECONDS
      })

      function serviceWith(limit: string, window: string) {
        process.env.BOXLITE_IMAGE_COLD_PULL_LIMIT = limit
        process.env.BOXLITE_IMAGE_COLD_PULL_WINDOW_SECONDS = window
        return build()
      }

      it('uses the limit and window an operator set', async () => {
        const tuned = serviceWith('2', '30')

        await tuned.spendColdPullBudget(organization, CATALOG_MISS)
        expect(redis.eval.mock.calls[0].slice(-2)).toEqual([30, 2])

        redis.eval.mockResolvedValue([3, 'gen-1', 30000])
        const error = await tuned.spendColdPullBudget(organization, CATALOG_MISS).catch((e) => e)
        expect(error.getResponse().message).toContain('at most 2 of them per 30s window')
      })

      /** A typo must stop the API at boot, not quietly fall back to the default. */
      it.each([
        ['0', '60'],
        ['six', '60'],
        ['6', '-1'],
      ])('refuses a limit of %s over %s seconds', (limit, window) => {
        expect(() => serviceWith(limit, window)).toThrow(/must be a positive integer/)
      })
    })
  })
})
