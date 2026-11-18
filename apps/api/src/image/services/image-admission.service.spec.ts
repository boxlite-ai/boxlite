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
      // The budget lives inside Lua scripts now; the mock answers with what a
      // real server returns for the same shape of call. A fresh spend lands
      // in generation 1 with a full minute left; anything else is a refund.
      eval: jest
        .fn()
        .mockImplementation((script: string) =>
          String(script).includes("redis.call('INCR', KEYS[1])")
            ? Promise.resolve([1, 'gen-1', 60000])
            : Promise.resolve(0),
        ),
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

    it('charges through one atomic script and hands back the ticket', async () => {
      const ticket = await service.spendColdPullBudget(organization, CATALOG_MISS)

      const [script, keyCount, counterKey, generationKey] = redis.eval.mock.calls[0]
      expect(script).toContain("redis.call('INCR', KEYS[1])")
      expect(keyCount).toBe(3)
      expect(counterKey).toBe('image:coldpull:org-1')
      expect(generationKey).toBe('image:coldpull:org-1:gen')
      expect(ticket).toEqual({ generation: 'gen-1', spent: 1 })
    })

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

    /** A key that lost its TTL must not block the organization for good. */
    it('answers a full window when the charged key has no expiry', async () => {
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

    it('hands the charged units back bound to the charged generation', async () => {
      await service.refundColdPullBudget(organization, CATALOG_MISS, { generation: 'gen-1', spent: 1 })

      const [script, keyCount, counterKey, generationKey, generation, spent] = redis.eval.mock.calls[0]
      expect(script).toContain("redis.call('GET', KEYS[2]) ~= ARGV[1]")
      expect(keyCount).toBe(2)
      expect(counterKey).toBe('image:coldpull:org-1')
      expect(generationKey).toBe('image:coldpull:org-1:gen')
      expect(generation).toBe('gen-1')
      expect(spent).toBe(1)
    })

    it('spends nothing to refund a ref the catalog answered', async () => {
      await service.refundColdPullBudget(
        organization,
        {
          ref: `quay.io/acme/app@sha256:${'a'.repeat(64)}`,
          isOrgOwned: true,
          imageId: 'image-1',
        },
        { generation: 'gen-1', spent: 1 },
      )
      expect(redis.eval).not.toHaveBeenCalled()
    })

    /**
     * The two races a mock cannot answer: does the script really run the way a
     * server reads it, and does an expired window really stay refunded-proof.
     * Requires a local redis-server executable for an isolated instance.
     * Missing test infrastructure fails setup instead of replacing this proof.
     */
    describe('against a real redis', () => {
      let serverDirectory: string

      let server: ChildProcess
      let client: Redis

      describe('isolated instance', () => {
        beforeAll(async () => {
          serverDirectory = await mkdtemp(join(tmpdir(), 'boxlite-image-admission-'))
          const socketPath = join(serverDirectory, 'redis.sock')
          server = spawn(
            'redis-server',
            ['--port', '0', '--unixsocket', socketPath, '--save', '', '--appendonly', 'no'],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          )
          server.once('error', (error) => server.stdout!.destroy(error))
          for await (const chunk of server.stdout!) {
            if (chunk.toString().includes('Ready to accept connections')) break
          }
          client = new Redis({ path: socketPath, lazyConnect: true, maxRetriesPerRequest: 2 })
          await client.connect()
        })

        afterAll(async () => {
          await client?.quit().catch(() => client?.disconnect())
          if (server && server.exitCode === null) {
            const stopped = once(server, 'exit')
            server.kill()
            await stopped
          }
          if (serverDirectory) await rm(serverDirectory, { recursive: true, force: true })
        })

        beforeEach(async () => {
          await client.flushall()
        })

        it('gives the charged unit back to the same window', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          const ticket = (await live.spendColdPullBudget(organization, CATALOG_MISS))!

          await live.refundColdPullBudget(organization, CATALOG_MISS, ticket)

          expect(await client.get('image:coldpull:org-1')).toBe('0')
        })

        it('refunds only one unit for each concurrent successful spend', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          const tickets = await Promise.all(
            Array.from({ length: 6 }, () => live.spendColdPullBudget(organization, CATALOG_MISS)),
          )

          expect(tickets.every((ticket) => ticket?.spent === 1)).toBe(true)
          await expect(live.spendColdPullBudget(organization, CATALOG_MISS)).rejects.toThrow(/at most 6/)
          await live.refundColdPullBudget(organization, CATALOG_MISS, tickets[5]!)

          expect(await client.get('image:coldpull:org-1')).toBe('6')
          await expect(live.spendColdPullBudget(organization, CATALOG_MISS)).rejects.toThrow(/at most 6/)
        })

        it('returns concurrent charges without refunding another pull', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          const tickets = await Promise.all(
            Array.from({ length: 6 }, () => live.spendColdPullBudget(organization, CATALOG_MISS)),
          )

          await Promise.all(
            tickets.slice(1).map((ticket) => live.refundColdPullBudget(organization, CATALOG_MISS, ticket!)),
          )

          expect(await client.get('image:coldpull:org-1')).toBe('1')
          await live.refundColdPullBudget(organization, CATALOG_MISS, tickets[0]!)
          expect(await client.get('image:coldpull:org-1')).toBe('0')
        })

        it('preserves the original window expiry when refunding a spend', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          const ticket = (await live.spendColdPullBudget(organization, CATALOG_MISS))!
          const deadline = Date.now() + 10000
          await client.pexpireat('image:coldpull:org-1', deadline)
          await client.pexpireat('image:coldpull:org-1:gen', deadline)

          await live.refundColdPullBudget(organization, CATALOG_MISS, ticket)

          const ttl = await client.pttl('image:coldpull:org-1')
          expect(ttl).toBeGreaterThan(0)
          expect(ttl).toBeLessThanOrEqual(10000)
          expect(Math.abs(ttl - (await client.pttl('image:coldpull:org-1:gen')))).toBeLessThan(1000)
        })

        it('keeps the same generation after a refund empties the window', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          const first = (await live.spendColdPullBudget(organization, CATALOG_MISS))!
          await live.refundColdPullBudget(organization, CATALOG_MISS, first)

          const second = (await live.spendColdPullBudget(organization, CATALOG_MISS))!

          expect(second).toEqual(first)
          expect(await client.get('image:coldpull:org-1:genseq')).toBe('1')
          await live.refundColdPullBudget(organization, CATALOG_MISS, second)
          expect(await client.get('image:coldpull:org-1')).toBe('0')
        })

        it('ignores a mismatched ticket while the current window is live', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          await live.spendColdPullBudget(organization, CATALOG_MISS)

          await live.refundColdPullBudget(organization, CATALOG_MISS, { generation: 'other-window', spent: 1 })

          expect(await client.get('image:coldpull:org-1')).toBe('1')
        })

        it('ignores a ticket whose counter expired before its generation', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          const ticket = (await live.spendColdPullBudget(organization, CATALOG_MISS))!
          await client.pexpire('image:coldpull:org-1', 0)

          await live.refundColdPullBudget(organization, CATALOG_MISS, ticket)

          expect(await client.exists('image:coldpull:org-1')).toBe(0)
        })

        it('keeps the count when the charged window has been replaced', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          const stale = (await live.spendColdPullBudget(organization, CATALOG_MISS))!

          // The original window expires and a fresh spend builds the next one,
          // exactly as a concurrent create would.
          await client.del('image:coldpull:org-1', 'image:coldpull:org-1:gen')
          const fresh = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          await fresh.spendColdPullBudget(organization, CATALOG_MISS)

          await live.refundColdPullBudget(organization, CATALOG_MISS, stale!)

          expect(await client.get('image:coldpull:org-1')).toBe('1')
          expect(await client.get('image:coldpull:org-1:gen')).toBe('2')
        })

        it('never resurrects an expired window', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          const stale = (await live.spendColdPullBudget(organization, CATALOG_MISS))!
          await client.del('image:coldpull:org-1', 'image:coldpull:org-1:gen')

          await live.refundColdPullBudget(organization, CATALOG_MISS, stale!)

          expect(await client.exists('image:coldpull:org-1')).toBe(0)
          expect(await client.exists('image:coldpull:org-1:gen')).toBe(0)
        })

        it('puts the same TTL on the counter and its generation', async () => {
          const live = new ImageAdmissionService(
            client,
            images as unknown as Repository<Image>,
            credentials as unknown as RegistryCredentialService,
          )
          await live.spendColdPullBudget(organization, CATALOG_MISS)

          const counterTtl = await client.pttl('image:coldpull:org-1')
          const generationTtl = await client.pttl('image:coldpull:org-1:gen')
          expect(counterTtl).toBeGreaterThan(0)
          expect(generationTtl).toBeGreaterThan(0)
          expect(Math.abs(counterTtl - generationTtl)).toBeLessThan(1000)
        })
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
        const [, , , , , windowSeconds, limit] = redis.eval.mock.calls[0]
        expect(windowSeconds).toBe(30)
        expect(limit).toBe(2)

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
