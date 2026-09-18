/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpStatus } from '@nestjs/common'
import Redis from 'ioredis'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { IsNull, Repository } from 'typeorm'
import { Organization } from '../../organization/entities/organization.entity'
import { Image } from '../entities/image.entity'
import { ImageCountLimitReachedError } from '../errors/image-admission.error'
import { ImageAdmissionService } from './image-admission.service'

type RedisMock = { incr: jest.Mock; expire: jest.Mock; ttl: jest.Mock }
type ImageRepositoryMock = { exists: jest.Mock; count: jest.Mock }

describe('ImageAdmissionService', () => {
  const organization = { id: 'org-1', imageCountLimit: 20 } as Organization

  let redis: RedisMock
  let images: ImageRepositoryMock
  let service: ImageAdmissionService

  beforeEach(() => {
    process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST = 'quay.io,gcr.io'
    redis = {
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      ttl: jest.fn().mockResolvedValue(60),
    }
    images = {
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
    }
    service = new ImageAdmissionService(redis as unknown as Redis, images as unknown as Repository<Image>)
  })

  afterEach(() => {
    delete process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST
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

  it('refuses a malformed ref before it spends any budget', async () => {
    await expect(service.assert(organization, 'quay.io/../etc/passwd')).rejects.toThrow(BadRequestError)
    expect(redis.incr).not.toHaveBeenCalled()
  })

  /**
   * Curated images were already allowed and are operator-chosen, so the gate
   * they predate must not start charging them for it. Checked with a spy rather
   * than by outcome: passing is what a broken gate would also do.
   */
  it('lets a curated selector through without spending budget', async () => {
    for (const selector of [undefined, 'python', 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0']) {
      await service.assert(organization, selector)
    }
    expect(redis.incr).not.toHaveBeenCalled()
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

    /**
     * Nothing returns a pull slot: the counter has no decrement, because the
     * API never learns a pull ended. Spending one on a create that was going to
     * be refused would charge an organization for a box it cannot have.
     */
    it('spends no pull budget on a create the limit refuses', async () => {
      images.count.mockResolvedValue(20)

      await service.assert(organization, 'quay.io/acme/app:v1').catch(() => undefined)

      expect(redis.incr).not.toHaveBeenCalled()
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
    it('sets the window on the first pull of a window', async () => {
      await service.assert(organization, 'quay.io/acme/app:v1')
      expect(redis.expire).toHaveBeenCalledWith('image:coldpull:org-1', 60)
    })

    it('does not reset the window on later pulls', async () => {
      redis.incr.mockResolvedValue(2)
      await service.assert(organization, 'quay.io/acme/app:v1')
      expect(redis.expire).not.toHaveBeenCalled()
    })

    /**
     * The filter turns a `retryAfterSeconds` on the exception into the
     * `Retry-After` header, but only for a positive safe integer, so that is
     * the shape this has to produce.
     */
    it('reports how long to wait when the budget is spent', async () => {
      redis.incr.mockResolvedValue(4)
      redis.ttl.mockResolvedValue(42)

      const error = await service.assert(organization, 'quay.io/acme/app:v1').catch((e) => e)

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
      redis.incr.mockResolvedValue(4)
      redis.ttl.mockResolvedValue(42)

      const error = await service.assert(organization, 'quay.io/acme/app:v1').catch((e) => e)

      expect(error.getResponse().message).toContain('at most 3 of them per 60s window')
      expect(error.getResponse().message).toContain('42s left')
    })

    /**
     * A key that lost its TTL would otherwise block the organization for good,
     * and a negative retry-after would be dropped by the filter, leaving a 429
     * with no guidance at all.
     */
    it('restores the window and still answers when the key has no expiry', async () => {
      redis.incr.mockResolvedValue(4)
      redis.ttl.mockResolvedValue(-1)

      const error = await service.assert(organization, 'quay.io/acme/app:v1').catch((e) => e)

      expect(redis.expire).toHaveBeenCalledWith('image:coldpull:org-1', 60)
      expect(error.retryAfterSeconds).toBe(60)
    })
  })
})
