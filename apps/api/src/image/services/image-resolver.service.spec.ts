/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InternalServerErrorException } from '@nestjs/common'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Repository } from 'typeorm'
import { Organization } from '../../organization/entities/organization.entity'
import { RegistryCredentialService } from '../../registry/services/registry-credential.service'
import { ImageVersion } from '../entities/image-version.entity'
import { assertPinnedOnCatalogHit, ImageResolverService } from './image-resolver.service'

const DIGEST = `sha256:${'a'.repeat(64)}`

describe('ImageResolverService', () => {
  const organization = { id: 'org-1' } as Organization
  /** An organization with no registered logins, which every pull before them was. */
  const noLogins = { routesThroughProxy: jest.fn(async () => false) } as unknown as RegistryCredentialService

  /**
   * Records the where-clauses and the values bound to them, so a test can assert
   * what was asked, not just what came back. The values matter as much as the
   * clauses: a lookup by the wrong tag name still searches by tag.
   */
  function makeRepository(row: Record<string, string> | undefined) {
    const conditions: string[] = []
    const parameters: Record<string, unknown> = {}
    const record = (clause: string, bound?: Record<string, unknown>) => {
      conditions.push(clause)
      Object.assign(parameters, bound)
      return builder
    }
    const builder = {
      innerJoin: jest.fn(() => builder),
      where: jest.fn(record),
      andWhere: jest.fn(record),
      select: jest.fn(() => builder),
      addSelect: jest.fn(() => builder),
      getRawOne: jest.fn(async () => row),
    }
    const createQueryBuilder = jest.fn(() => builder)
    return {
      repository: { createQueryBuilder } as unknown as Repository<ImageVersion>,
      createQueryBuilder,
      conditions,
      parameters,
    }
  }

  describe('curated selectors', () => {
    it.each([
      [undefined, 'boxlite-agent-base'],
      ['base', 'boxlite-agent-base'],
      ['python', 'boxlite-agent-python'],
      ['ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0', 'boxlite-agent-node'],
    ])('resolves %s from the curated set', async (selector, expected) => {
      const { repository } = makeRepository(undefined)
      const resolved = await new ImageResolverService(repository, noLogins).resolve(
        organization,
        selector as string | undefined,
      )

      expect(resolved.ref).toContain(expected)
      expect(resolved.isOrgOwned).toBe(false)
      expect(resolved.imageId).toBeUndefined()
    })

    /**
     * The curated path is what every caller took before the catalog existed, so
     * it must not start paying for it. Asserted on the query builder rather than
     * the result, because the right answer is what a broken version returns too.
     */
    it('reaches no database at all', async () => {
      const { repository, createQueryBuilder } = makeRepository(undefined)
      await new ImageResolverService(repository, noLogins).resolve(organization, 'python')
      expect(createQueryBuilder).not.toHaveBeenCalled()
    })
  })

  describe('catalog hits', () => {
    it('pins a tag to the digest it first resolved to', async () => {
      const { repository } = makeRepository({ digest: DIGEST, imageId: 'img-1' })

      const resolved = await new ImageResolverService(repository, noLogins).resolve(organization, 'quay.io/acme/app:v1')

      expect(resolved).toEqual({ ref: `quay.io/acme/app@${DIGEST}`, isOrgOwned: true, imageId: 'img-1' })
    })

    /**
     * Which tag, not just that a tag was used. `latest` is the name the registry
     * serves a bare repository under, so it is the name the registrar records —
     * and a lookup that searched for anything else would miss its own row and
     * re-resolve the reference forever.
     */
    it('looks a bare repository up under the tag the registry serves it as', async () => {
      const { repository, conditions, parameters } = makeRepository({ digest: DIGEST, imageId: 'img-1' })

      const resolved = await new ImageResolverService(repository, noLogins).resolve(organization, 'quay.io/acme/app')

      expect(conditions).toContain('tag.name = :tag')
      expect(parameters.tag).toBe('latest')
      expect(resolved.ref).toBe(`quay.io/acme/app@${DIGEST}`)
    })

    it('reports the row for a ref the caller already pinned', async () => {
      const { repository } = makeRepository({ imageId: 'img-1' })

      const resolved = await new ImageResolverService(repository, noLogins).resolve(
        organization,
        `quay.io/acme/app@${DIGEST}`,
      )

      expect(resolved).toEqual({ ref: `quay.io/acme/app@${DIGEST}`, isOrgOwned: true, imageId: 'img-1' })
    })

    /**
     * Deleting an image is the only thing that picks up a tag that moved
     * upstream, so a soft-deleted row resolving would close the one escape
     * hatch there is.
     */
    it('excludes soft-deleted images from every lookup', async () => {
      const { repository, conditions } = makeRepository(undefined)
      const service = new ImageResolverService(repository, noLogins)

      await service.resolve(organization, 'quay.io/acme/app:v1')
      await service.resolve(organization, `quay.io/acme/app@${DIGEST}`)

      expect(conditions.filter((c) => c.includes('"deletedAt" IS NULL'))).toHaveLength(2)
    })
  })

  describe('catalog misses', () => {
    it('passes a tag through unchanged rather than inventing a digest', async () => {
      const { repository } = makeRepository(undefined)

      const resolved = await new ImageResolverService(repository, noLogins).resolve(organization, 'quay.io/acme/app:v1')

      expect(resolved).toEqual({ ref: 'quay.io/acme/app:v1', isOrgOwned: true })
    })

    it('leaves a bare repository exactly as typed', async () => {
      const { repository } = makeRepository(undefined)

      const resolved = await new ImageResolverService(repository, noLogins).resolve(organization, 'quay.io/acme/app')

      // `latest` is what the catalog was searched for, not something to write
      // into the ref: a runner resolves a bare repository the same way.
      expect(resolved.ref).toBe('quay.io/acme/app')
      expect(resolved.imageId).toBeUndefined()
    })

    it('keeps an already-pinned ref when the catalog does not know it', async () => {
      const { repository } = makeRepository(undefined)

      const resolved = await new ImageResolverService(repository, noLogins).resolve(
        organization,
        `quay.io/acme/app@${DIGEST}`,
      )

      expect(resolved).toEqual({ ref: `quay.io/acme/app@${DIGEST}`, isOrgOwned: true })
    })
  })

  /**
   * A runner caches by the ref string it was handed, so an unpinned catalog hit
   * would leave which build a box gets depending on which runner it landed on.
   * The assertion is the only thing between that and a silent wrong answer, so
   * it is tested from both sides.
   */
  describe('assertPinnedOnCatalogHit', () => {
    it('rejects a hit that is not digest-pinned', () => {
      expect(() =>
        assertPinnedOnCatalogHit({ ref: 'quay.io/acme/app:v1', isOrgOwned: true, imageId: 'img-1' }),
      ).toThrow(InternalServerErrorException)
    })

    it('accepts a pinned hit, and a miss whatever its shape', () => {
      expect(() =>
        assertPinnedOnCatalogHit({ ref: `quay.io/acme/app@${DIGEST}`, isOrgOwned: true, imageId: 'img-1' }),
      ).not.toThrow()
      expect(() => assertPinnedOnCatalogHit({ ref: 'quay.io/acme/app:v1', isOrgOwned: true })).not.toThrow()
    })
  })
  describe('private registries', () => {
    const PROXY = 'registry-proxy-abc.a.run.app'
    // acme registered a login for ghcr.io/acme/ and one for the whole of
    // Docker Hub's library/.
    const logins = {
      routesThroughProxy: jest.fn(
        async (_org: string, host: string, repository: string) =>
          (host === 'ghcr.io' && repository.startsWith('acme/')) ||
          (host === 'docker.io' && repository.startsWith('library/')),
      ),
    }
    const resolverWith = (row: Record<string, string> | undefined) =>
      new ImageResolverService(makeRepository(row).repository, logins as unknown as RegistryCredentialService)

    beforeEach(() => {
      process.env.REGISTRY_PROXY_HOST = PROXY
      logins.routesThroughProxy.mockClear()
    })

    afterEach(() => {
      delete process.env.REGISTRY_PROXY_HOST
      delete process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST
    })

    it('hands a repository a login covers to the runner through the proxy', async () => {
      const resolved = await resolverWith(undefined).resolve(organization, 'ghcr.io/acme/app:1')

      expect(resolved.ref).toBe(`${PROXY}/org-1/ghcr.io/acme/app:1`)
      expect(logins.routesThroughProxy).toHaveBeenCalledWith('org-1', 'ghcr.io', 'acme/app')
    })

    it('leaves a repository no login covers on the direct path, where the allowlist admits it', async () => {
      process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST = 'ghcr.io,docker.io'

      const resolved = await resolverWith(undefined).resolve(organization, 'ghcr.io/other/app:1')

      expect(resolved.ref).toBe('ghcr.io/other/app:1')
    })

    it('refuses a direct ref the allowlist does not admit, even after admission let it through', async () => {
      // Admission found a login; it was removed before this ran. Handing the
      // runner a direct ref now would skip the gate admission relied on.
      process.env.BOXLITE_IMAGE_REGISTRY_ALLOWLIST = 'docker.io'

      await expect(resolverWith(undefined).resolve(organization, 'ghcr.io/other/app:1')).rejects.toThrow(
        BadRequestError,
      )
    })

    it('keeps a catalog hit pinned when it goes through the proxy', async () => {
      const resolved = await resolverWith({ digest: DIGEST, imageId: 'image-1' }).resolve(
        organization,
        'ghcr.io/acme/app:1',
      )

      expect(resolved).toEqual({
        ref: `${PROXY}/org-1/ghcr.io/acme/app@${DIGEST}`,
        isOrgOwned: true,
        imageId: 'image-1',
      })
    })

    it('sends the three spellings of one Docker Hub image down one proxy path', async () => {
      const refs = await Promise.all(
        ['alpine:3.20', 'docker.io/alpine:3.20', 'library/alpine:3.20'].map(
          async (ref) => (await resolverWith(undefined).resolve(organization, ref)).ref,
        ),
      )

      expect(new Set(refs)).toEqual(new Set([`${PROXY}/org-1/docker.io/library/alpine:3.20`]))
    })

    it('answers a curated selector first, without asking about logins', async () => {
      // Even with a login for the curated image's host, the curated set wins
      // and nothing is looked up.
      logins.routesThroughProxy.mockImplementation(async () => true)
      const resolved = await resolverWith(undefined).resolve(organization, 'python')

      expect(resolved.ref).toContain('boxlite-agent-python')
      expect(resolved.ref).not.toContain(PROXY)
      expect(logins.routesThroughProxy).not.toHaveBeenCalled()
    })
  })
})
