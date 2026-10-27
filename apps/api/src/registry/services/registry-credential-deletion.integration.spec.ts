/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import { IsolationLevel } from 'typeorm/driver/types/IsolationLevel'
import { Box } from '../../box/entities/box.entity'
import { BoxLastActivity } from '../../box/entities/box-last-activity.entity'
import { BoxMigration } from '../../box/entities/box-migration.entity'
import { BoxRepository } from '../../box/repositories/box.repository'
import { BoxService } from '../../box/services/box.service'
import { Context } from '../../common/context/context'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Image } from '../../image/entities/image.entity'
import { ImageAlias } from '../../image/entities/image-alias.entity'
import { ImageVersion } from '../../image/entities/image-version.entity'
import { ImageResolverService } from '../../image/services/image-resolver.service'
import { Organization } from '../../organization/entities/organization.entity'
import { RegistryCredential } from '../entities/registry-credential.entity'
import { RegistriesService } from './registries.service'
import { RegistryCredentialService } from './registry-credential.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const databaseName = `credential_delete_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organization = { id: '00000000-0000-4000-8000-000000000001' } as Organization
const proxyHost = 'registry-proxy.test'
const image = 'ghcr.io/acme/app:1'

function barrier() {
  let entered!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => (entered = resolve))
  const resumed = new Promise<void>((resolve) => (release = resolve))
  return {
    reached,
    release,
    pause: async () => {
      entered()
      await resumed
    },
  }
}

function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  )
}

async function reachedBeforeCompletion(gate: ReturnType<typeof barrier>, task: Promise<unknown>) {
  await Promise.race([
    gate.reached,
    task.then(() => {
      throw new Error('Operation completed before reaching the concurrency barrier')
    }),
  ])
}

describeIfDatabase('Registry credential deletion concurrency (integration, real Postgres)', () => {
  let creatorDb: DataSource
  let deleterDb: DataSource
  let ownsDatabase = false
  let createService: BoxService
  let registries: RegistriesService
  let credential: RegistryCredential
  let store: { put: jest.Mock; destroy: jest.Mock }
  let runner: { getRandomAvailableRunner: jest.Mock }
  const oldProxyHost = process.env.REGISTRY_PROXY_HOST

  const connection = {
    type: 'postgres' as const,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  }

  beforeAll(async () => {
    const admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      ownsDatabase = true
    } finally {
      await admin.destroy()
    }
    const options = {
      ...connection,
      database: databaseName,
      entities: [Box, BoxLastActivity, BoxMigration, RegistryCredential, Image, ImageAlias, ImageVersion],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
    }
    creatorDb = await new DataSource(options).initialize()
    await creatorDb.synchronize()
    // Separate pools model requests handled by different API replicas.
    deleterDb = await new DataSource(options).initialize()
  })

  afterAll(async () => {
    if (creatorDb?.isInitialized) await creatorDb.destroy()
    if (deleterDb?.isInitialized) await deleterDb.destroy()
    if (ownsDatabase) {
      const admin = await new DataSource({ ...connection, database: process.env.DB_DATABASE }).initialize()
      try {
        await admin.query(`DROP DATABASE "${databaseName}"`)
      } finally {
        await admin.destroy()
      }
    }
    if (oldProxyHost === undefined) delete process.env.REGISTRY_PROXY_HOST
    else process.env.REGISTRY_PROXY_HOST = oldProxyHost
  })

  beforeEach(async () => {
    process.env.REGISTRY_PROXY_HOST = proxyHost
    await creatorDb.query('TRUNCATE registry_credential, box_last_activity, box CASCADE')
    const lookup = (db: DataSource) =>
      new RegistryCredentialService(db.getRepository(RegistryCredential), db.getRepository(Box))
    store = { put: jest.fn().mockResolvedValue('test-secret-version'), destroy: jest.fn().mockResolvedValue(undefined) }
    registries = new RegistriesService(deleterDb.getRepository(RegistryCredential), store)
    credential = await registries.create(organization.id, 'test-user', {
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/',
      username: 'test-user',
      password: 'test-only-password',
    })
    runner = { getRandomAvailableRunner: jest.fn().mockResolvedValue({ id: randomUUID() }) }
    createService = Object.create(BoxService.prototype) as BoxService
    Object.assign(createService, {
      getValidatedOrDefaultRegion: jest.fn().mockResolvedValue({ id: 'us' }),
      getValidatedOrDefaultClass: jest.fn().mockReturnValue('small'),
      organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
      redis: { exists: jest.fn().mockResolvedValue(1) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      runnerService: runner,
      boxRepository: new BoxRepository(
        creatorDb,
        { emit: jest.fn() } as never,
        { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
      ),
      eventEmitter: { emitAsync: jest.fn().mockResolvedValue(undefined) },
      toBoxDto: jest.fn((box) => box),
      imageAdmissionService: { assert: jest.fn(), spendColdPullBudget: jest.fn() },
      imageResolverService: new ImageResolverService(creatorDb.getRepository(ImageVersion), lookup(creatorDb)),
    })
  })

  function create(maxCreatedBoxes?: number, requestedImage = image) {
    return createService.create(
      { name: `test-${randomUUID()}`, image: requestedImage } as never,
      organization,
      Context.user(),
      { maxCreatedBoxes },
    )
  }

  it('reads credential candidates once while preserving longest-prefix dependencies', async () => {
    await registries.create(organization.id, 'test-user', {
      registryHost: 'ghcr.io',
      repositoryPrefix: 'acme/team/',
      username: 'test-user',
      password: 'test-only-password',
    })
    const dependent = await create()
    const shadowed = [
      await create(undefined, 'ghcr.io/acme/team/app:1'),
      await create(undefined, 'ghcr.io/acme/team/tool:1'),
    ]
    const queries = jest.spyOn(deleterDb.logger, 'logQuery')
    try {
      const result = await outcome(registries.delete(organization.id, credential.id))
      expect(result.error).toBeInstanceOf(ConflictException)
      const message = (result.error as ConflictException).message
      expect(message).toContain(dependent.id)
      for (const box of shadowed) expect(message).not.toContain(box.id)
      expect(store.destroy).not.toHaveBeenCalled()
      expect(
        queries.mock.calls.filter(([sql]) => sql.startsWith('SELECT') && sql.includes('FROM "registry_credential"')),
      ).toHaveLength(2)
    } finally {
      queries.mockRestore()
    }
  })

  it.each([undefined, 10])('rejects creation while deletion owns the credential (box limit %s)', async (limit) => {
    const gate = barrier()
    store.destroy.mockImplementation(gate.pause)
    const deleting = outcome(registries.delete(organization.id, credential.id))
    try {
      await reachedBeforeCompletion(gate, deleting)
      const result = await outcome(create(limit))
      expect(result.error).toBeInstanceOf(ConflictException)
      expect(await creatorDb.getRepository(Box).count()).toBe(0)
    } finally {
      gate.release()
      await deleting
    }
    expect((await deleting).error).toBeUndefined()
    await expect(create(undefined, 'python')).resolves.toBeDefined()
  })

  it.each([undefined, 10])(
    'rejects deletion while creation has not committed its box (box limit %s)',
    async (limit) => {
      const gate = barrier()
      const transaction = creatorDb.transaction.bind(creatorDb)
      const spy = jest.spyOn(creatorDb, 'transaction').mockImplementation(async (...args: unknown[]) => {
        const persist = args[args.length - 1] as (manager: EntityManager) => Promise<unknown>
        const gated = async (manager: EntityManager) => {
          const insert = manager.insert.bind(manager)
          manager.insert = async (target, entity) => {
            const result = await insert(target, entity)
            if (target === Box) await gate.pause()
            return result
          }
          return persist(manager)
        }
        return typeof args[0] === 'string' ? transaction(args[0] as IsolationLevel, gated) : transaction(gated)
      })
      const creating = outcome(create(limit))
      try {
        await reachedBeforeCompletion(gate, creating)
        const result = await outcome(registries.delete(organization.id, credential.id))
        expect(result.error).toBeInstanceOf(ConflictException)
        expect(store.destroy).not.toHaveBeenCalled()
      } finally {
        gate.release()
        await creating
        spy.mockRestore()
      }
      expect((await creating).error).toBeUndefined()
      expect(await creatorDb.getRepository(RegistryCredential).count()).toBe(1)
      const created = (await creating).value
      if (!created) throw new Error('Expected the pending box to commit')
      await expect(registries.delete(organization.id, credential.id)).rejects.toThrow(created.id)
    },
  )

  it.each([undefined, 10])('rejects a proxy ref resolved before deletion completed (box limit %s)', async (limit) => {
    const gate = barrier()
    runner.getRandomAvailableRunner.mockImplementation(async () => {
      await gate.pause()
      return { id: randomUUID() }
    })
    const creating = outcome(create(limit))
    try {
      await reachedBeforeCompletion(gate, creating)
      await registries.delete(organization.id, credential.id)
    } finally {
      gate.release()
    }
    expect((await creating).error).toBeInstanceOf(ConflictException)
    expect(await creatorDb.getRepository(Box).count()).toBe(0)
  })
})
