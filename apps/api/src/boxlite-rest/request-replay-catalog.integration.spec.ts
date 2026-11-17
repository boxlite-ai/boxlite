// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { randomUUID } from 'node:crypto'
import { IsNull } from 'typeorm'
import { ReplayBusinessFixture } from '../../test/request-replay-business.fixture'
import { BoxliteRegistryController } from './boxlite-registry.controller'
import { BoxliteImageController } from './boxlite-image.controller'
import { RegistriesService } from '../registry/services/registries.service'
import { RegistryCredential } from '../registry/entities/registry-credential.entity'
import { ImageCatalogService } from '../image/services/image-catalog.service'
import { ImageRegistrarService } from '../image/services/image-registrar.service'
import { Image } from '../image/entities/image.entity'
import { ImageVersion } from '../image/entities/image-version.entity'
import { ImageAlias } from '../image/entities/image-alias.entity'
import { ImageAliasEvent } from '../image/entities/image-alias-event.entity'
import { Box } from '../box/entities/box.entity'
import { AuditLog } from '../audit/entities/audit-log.entity'

const describeWithServices = process.env.DB_HOST && process.env.REDIS_HOST ? describe : describe.skip

describeWithServices('Request replay catalog (HTTP, PostgreSQL and Redis)', () => {
  let fixture: ReplayBusinessFixture
  let registries: RegistriesService
  let catalog: ImageCatalogService
  let registrar: ImageRegistrarService
  const secret = { put: jest.fn(), destroy: jest.fn() }
  const digest = `sha256:${'a'.repeat(64)}`
  const name = 'quay.io/replay/app'
  const route = `images/${encodeURIComponent(name)}`
  const previousRegistryProxyHost = process.env.REGISTRY_PROXY_HOST

  beforeEach(async () => {
    process.env.REGISTRY_PROXY_HOST = 'registry-proxy.replay.test'
    fixture = new ReplayBusinessFixture()
    await fixture.open()
    secret.put.mockReset().mockImplementation(async () => randomUUID())
    secret.destroy.mockReset().mockResolvedValue(undefined)
    registries = new RegistriesService(fixture.db.getRepository(RegistryCredential), secret)
    catalog = new ImageCatalogService(
      fixture.db.getRepository(Image),
      fixture.db.getRepository(ImageVersion),
      fixture.db.getRepository(ImageAlias),
      fixture.db.getRepository(ImageAliasEvent),
      fixture.db.getRepository(Box),
    )
    registrar = new ImageRegistrarService(fixture.db, { remember: async () => undefined } as never)
    await fixture.serve(
      [BoxliteRegistryController, BoxliteImageController],
      [
        { provide: RegistriesService, useValue: registries },
        { provide: ImageCatalogService, useValue: catalog },
      ],
    )
  })
  afterEach(async () => {
    try {
      await fixture?.close()
    } finally {
      if (previousRegistryProxyHost === undefined) delete process.env.REGISTRY_PROXY_HOST
      else process.env.REGISTRY_PROXY_HOST = previousRegistryProxyHost
    }
  })

  it('retains the original registry identity and writes a secret once while auditing both attempts', async () => {
    const key = randomUUID()
    const body = { registry_host: 'quay.io', username: 'replay-user', password: 'test-only-password' }
    const original = await fixture.request('POST', 'images/registries', key, body)
    expect(original.status).toBe(201)
    expect(original.body).toMatchObject({ registry_host: 'quay.io', username: 'replay-user' })
    const credential = await fixture.db
      .getRepository(RegistryCredential)
      .findOneByOrFail({ organizationId: fixture.organization.id })
    expect(original.body?.id).toBe(credential.id)
    await fixture.replay('POST', 'images/registries', key, original, body)
    expect(await fixture.db.getRepository(RegistryCredential).count()).toBe(1)
    expect(secret.put).toHaveBeenCalledTimes(1)
    expect(await fixture.db.getRepository(AuditLog).count()).toBe(2)
    expect(original.text).not.toContain(body.password)
    const businessBefore = [...fixture.events]
    const deleteKey = randomUUID()
    const removed = await fixture.request('DELETE', `images/registries/${credential.id}`, deleteKey)
    expect(removed).toMatchObject({ status: 204, text: '' })
    expect(await fixture.db.getRepository(RegistryCredential).count()).toBe(0)
    await fixture.replay('DELETE', `images/registries/${credential.id}`, deleteKey, removed)
    expect(secret.destroy).toHaveBeenCalledTimes(1)
    expect(fixture.events).toEqual(businessBefore)
    expect(await fixture.db.getRepository(AuditLog).count()).toBe(4)
  })

  it('does not append alias history again or delete a replacement alias or image', async () => {
    await registrar.onBoxStarted(
      fixture.organization.id,
      { ref: `${name}:source`, isOrgOwned: true },
      { digest, sizeBytes: 4096 },
    )
    const body = { alias: 'stable', digest }
    const createKey = randomUUID()
    const created = await fixture.request('POST', `${route}/aliases`, createKey, body)
    const historyCount = await fixture.db.getRepository(ImageAliasEvent).count()
    await fixture.replay('POST', `${route}/aliases`, createKey, created, body)
    expect(await fixture.db.getRepository(ImageAliasEvent).count()).toBe(historyCount)
    const deleteKey = randomUUID()
    const removed = await fixture.request('DELETE', `${route}/aliases/stable`, deleteKey)
    await catalog.createAlias(fixture.organization, name, 'stable', { digest }, fixture.userId)
    const replacement = await fixture.db.getRepository(ImageAlias).findOneByOrFail({ name: 'stable' })
    await fixture.replay('DELETE', `${route}/aliases/stable`, deleteKey, removed)
    expect(await fixture.db.getRepository(ImageAlias).findOneByOrFail({ id: replacement.id })).toEqual(replacement)
    const removeKey = randomUUID()
    const imageRemoved = await fixture.request('DELETE', route, removeKey)
    expect(await fixture.db.getRepository(Image).countBy({ deletedAt: IsNull() })).toBe(0)
    await registrar.onBoxStarted(
      fixture.organization.id,
      { ref: `${name}:source`, isOrgOwned: true },
      { digest, sizeBytes: 8192 },
    )
    const replacementImage = await fixture.db
      .getRepository(Image)
      .findOneByOrFail({ organizationId: fixture.organization.id, deletedAt: IsNull() })
    await fixture.replay('DELETE', route, removeKey, imageRemoved)
    expect(await fixture.db.getRepository(Image).findOneByOrFail({ id: replacementImage.id })).toEqual(replacementImage)
  })
})
