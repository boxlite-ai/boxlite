/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, NotFoundException, NotImplementedException } from '@nestjs/common'
import { Repository } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { SecretStore } from '../stores/secret.store'
import { RegistriesService } from './registries.service'
import { RegistryCredentialService } from './registry-credential.service'

const PROXY = 'registry-proxy-abc.a.run.app'
const ORG = '0aaa0000-0000-4000-8000-000000000001'
const REQUEST = { registryHost: 'ghcr.io', repositoryPrefix: 'acme/', username: 'acme-bot', password: 'ghp_x' }

function build({
  store = { put: jest.fn(async () => 'version-1'), destroy: jest.fn(async () => undefined) },
  row = { id: 'credential-1', organizationId: ORG, registryHost: 'ghcr.io', secretVersion: 'version-1' },
  boxes = [] as Partial<Box>[],
  picked = 'credential-1' as string | null,
} = {}) {
  const calls: string[] = []
  const credentials = {
    insert: jest.fn(async () => calls.push('insert')),
    findOneByOrFail: jest.fn(async () => ({ ...row })),
    findOneBy: jest.fn(async () => row),
    delete: jest.fn(async () => calls.push('delete')),
    find: jest.fn(async () => [row]),
  }
  const builder = {
    where: jest.fn(() => builder),
    andWhere: jest.fn(() => builder),
    select: jest.fn(() => builder),
    getMany: jest.fn(async () => boxes),
  }
  const lookup = { findForRepository: jest.fn(async () => (picked ? { id: picked } : null)) }
  store.destroy.mockImplementation(async () => {
    calls.push('destroy')
  })
  const service = new RegistriesService(
    credentials as unknown as Repository<RegistryCredential>,
    { createQueryBuilder: () => builder } as unknown as Repository<Box>,
    store as unknown as SecretStore,
    lookup as unknown as RegistryCredentialService,
  )
  return { service, credentials, store, builder, calls, lookup }
}

describe('RegistriesService', () => {
  beforeEach(() => {
    process.env.REGISTRY_PROXY_HOST = PROXY
  })

  afterEach(() => {
    delete process.env.REGISTRY_PROXY_HOST
  })

  describe('create', () => {
    it('writes the password to the store and records only where it went', async () => {
      const { service, credentials, store } = build()

      await service.create(ORG, 'user-1', REQUEST)

      expect(store.put).toHaveBeenCalledWith(expect.any(String), 'ghp_x')
      const [inserted] = credentials.insert.mock.calls[0] as unknown as [Record<string, unknown>]
      expect(inserted).toMatchObject({ registryHost: 'ghcr.io', repositoryPrefix: 'acme/', secretVersion: 'version-1' })
      expect(JSON.stringify(inserted)).not.toContain('ghp_x')
      // The row's id is the secret's name, so the two cannot drift apart.
      expect(inserted.id).toBe((store.put.mock.calls[0] as unknown as [string])[0])
    })

    it('destroys the password again when a second login for the same prefix is refused', async () => {
      const { service, credentials, store } = build()
      credentials.insert.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }))

      await expect(service.create(ORG, 'user-1', REQUEST)).rejects.toBeInstanceOf(ConflictException)
      expect(store.destroy).toHaveBeenCalledWith('version-1')
    })

    it('destroys the password on any other failure to record it, and reports that failure', async () => {
      const { service, credentials, store } = build()
      credentials.insert.mockRejectedValue(new Error('connection reset'))

      await expect(service.create(ORG, 'user-1', REQUEST)).rejects.toThrow('connection reset')
      expect(store.destroy).toHaveBeenCalledWith('version-1')
    })

    it('refuses with 501 where there is no proxy to present a login', async () => {
      delete process.env.REGISTRY_PROXY_HOST
      const { service, store } = build()

      await expect(service.create(ORG, 'user-1', REQUEST)).rejects.toBeInstanceOf(NotImplementedException)
      expect(store.put).not.toHaveBeenCalled()
    })
  })

  describe('delete', () => {
    it('refuses with the ids of the boxes still pulling through it', async () => {
      const { service, store, builder, lookup } = build({
        boxes: [
          { id: 'box-1', image: `${PROXY}/${ORG}/ghcr.io/acme/app:1` },
          { id: 'box-2', image: `${PROXY}/${ORG}/ghcr.io/acme/tool@sha256:${'a'.repeat(64)}` },
        ],
      })

      const refused = service.delete(ORG, 'credential-1')

      await expect(refused).rejects.toBeInstanceOf(ConflictException)
      await expect(refused).rejects.toThrow(/box-1, box-2/)
      expect(store.destroy).not.toHaveBeenCalled()
      // The boxes asked about: this organization's, not destroyed, and pulling
      // through the proxy from this login's host.
      expect(builder.where).toHaveBeenCalledWith('box.organizationId = :organizationId', { organizationId: ORG })
      expect(builder.andWhere).toHaveBeenCalledWith('box.desiredState != :destroyed', { destroyed: 'destroyed' })
      expect(builder.andWhere).toHaveBeenCalledWith('box.image LIKE :through', {
        through: `${PROXY}/${ORG}/ghcr.io/%`,
      })
      // And each one is matched by its upstream repository, not the proxy ref.
      expect(lookup.findForRepository).toHaveBeenCalledWith(ORG, 'ghcr.io', 'acme/app')
      expect(lookup.findForRepository).toHaveBeenCalledWith(ORG, 'ghcr.io', 'acme/tool')
    })

    it('lets a login go when a longer one is what its boxes pull through', async () => {
      const { service, calls } = build({
        boxes: [{ id: 'box-1', image: `${PROXY}/${ORG}/ghcr.io/acme/app:1` }],
        picked: 'a-longer-prefix',
      })

      await service.delete(ORG, 'credential-1')

      expect(calls).toEqual(['destroy', 'delete'])
    })

    it('destroys the password before removing the row', async () => {
      const { service, calls } = build()

      await service.delete(ORG, 'credential-1')

      // The other order, interrupted, leaves a readable password nothing lists.
      expect(calls).toEqual(['destroy', 'delete'])
    })

    it('answers 404 for a login the organization does not have', async () => {
      const { service, credentials } = build()
      credentials.findOneBy.mockResolvedValue(null as never)

      await expect(service.delete(ORG, 'credential-9')).rejects.toBeInstanceOf(NotFoundException)
    })
  })
})
