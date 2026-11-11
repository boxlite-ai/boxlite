import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { BoxRequestService } from './box-request.service'
import { AddBoxRequests1794390000000 } from '../migrations/pre-deploy/1794390000000-add-box-requests-migration'
import { BoxRepository } from '../box/repositories/box.repository'
import { Box } from '../box/entities/box.entity'
import { BoxLastActivity } from '../box/entities/box-last-activity.entity'
import { CustomNamingStrategy } from '../common/utils/naming-strategy.util'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../box/constants/box.constants'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDto } from '../box/dto/box.dto'
import { BoxliteBoxController } from './boxlite-box.controller'
import { Context } from '../common/context/context'
import { boxToBoxResponse } from './mappers/box-to-box.mapper'

const describeDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `request_${randomUUID().replaceAll('-', '')}`
const organizationId = randomUUID()

describeDatabase('Box request recovery with real PostgreSQL', () => {
  let database: DataSource
  let repository: BoxRepository
  let requests: BoxRequestService
  const scope = [organizationId, 'owner', 'createBox']

  function box(owner = organizationId) {
    const value = new Box('us', randomUUID())
    value.organizationId = owner
    value.osUser = 'boxlite'
    value.labels = {}
    value.pending = true
    return value
  }

  beforeAll(async () => {
    database = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Box, BoxLastActivity],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      extra: { options: `-c search_path=${schema},public`, max: 1, connectionTimeoutMillis: 1000 },
    }).initialize()
    await database.query(`CREATE SCHEMA "${schema}"`)
    await database.synchronize()
    const runner = database.createQueryRunner()
    try {
      await new AddBoxRequests1794390000000().up(runner)
    } finally {
      await runner.release()
    }
    repository = new BoxRepository(
      database,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
    )
    requests = new BoxRequestService(database)
  })

  afterAll(async () => {
    await requests?.onModuleDestroy()
    if (database?.isInitialized) {
      try {
        await database.query(`DROP SCHEMA "${schema}" CASCADE`)
      } finally {
        await database.destroy()
      }
    }
  })

  beforeEach(async () => {
    await database.query('TRUNCATE box_request, box_last_activity, box')
  })

  it('retries lock-pool initialization after a transient database failure', async () => {
    const service = new BoxRequestService(database)
    const initialize = jest.spyOn(DataSource.prototype, 'initialize')
    initialize.mockRejectedValueOnce(new Error('database temporarily unavailable'))
    const create = jest.fn(async () => ({ id: 'recovered' }))
    try {
      await expect(service.run(scope, randomUUID(), {}, create)).rejects.toThrow('database temporarily unavailable')
      initialize.mockRestore()
      await expect(service.run(scope, randomUUID(), {}, create)).resolves.toEqual({ id: 'recovered' })
      expect(create).toHaveBeenCalledTimes(1)
    } finally {
      initialize.mockRestore()
      await service.onModuleDestroy().catch(() => {})
    }
  })

  it.each(['fresh', 'warm'])('recovers %s ownership after crashing before response persistence', async (path) => {
    const key = randomUUID()
    const value = box(path === 'warm' ? BOX_WARM_POOL_UNASSIGNED_ORGANIZATION : organizationId)
    if (path === 'warm') {
      value.state = BoxState.STARTED
      value.pending = false
      await repository.insert(value)
    }
    await expect(
      requests.run(scope, key, { image: 'alpine' }, async (bind) => {
        if (path === 'warm') {
          await repository.update(value.id, { updateData: { organizationId }, maxCreatedBoxes: 1, bindRequest: bind })
        } else {
          await repository.insert(value, 1, undefined, undefined, undefined, bind)
        }
        throw new Error('simulated API crash')
      }),
    ).rejects.toThrow('simulated API crash')
    const retry = requests
    const result = await retry.run(scope, key, { image: 'alpine' }, async (_bind, id) => {
      expect(id).toBe(value.id)
      return { box_id: id, status: 'running' }
    })
    const forbiddenCreate = jest.fn()
    await expect(retry.run(scope, key, { image: 'alpine' }, forbiddenCreate)).resolves.toEqual(result)
    expect(forbiddenCreate).not.toHaveBeenCalled()
    expect(await database.getRepository(Box).countBy({ organizationId })).toBe(1)
    await expect(retry.run(scope, key, { image: 'different' }, forbiddenCreate)).rejects.toMatchObject({ status: 422 })
  })

  it('recovers the public DTO after resource binding without a saved response', async () => {
    const key = randomUUID()
    const value = box()
    value.mem = 4
    value.inboundEnabled = true
    value.outboundEnabled = false
    const payload = { image: 'alpine' }
    await expect(
      requests.run(scope, key, payload, async (bind) => {
        await repository.insert(value, 1, undefined, undefined, undefined, bind)
        throw new Error('response lost')
      }),
    ).rejects.toThrow('response lost')
    const create = jest.fn()
    const service = {
      create,
      findOneByIdOrName: (id: string) => database.getRepository(Box).findOneByOrFail({ id }),
      toBoxDto: async (entity: Box) => BoxDto.fromBox(entity, {}),
    }
    const controller = Reflect.construct(BoxliteBoxController, [service, {}, {}, {}, requests]) as BoxliteBoxController
    const result = await controller.createBox(
      { organizationId, organization: { id: organizationId }, userId: 'owner' } as never,
      payload as never,
      Context.user(),
      { headers: { 'idempotency-key': key } } as never,
    )
    const persisted = await database.getRepository(Box).findOneByOrFail({ id: value.id })
    expect(result.memory_mib).toBe(4096)
    expect(result).toEqual(boxToBoxResponse(BoxDto.fromBox(persisted, {})))
    expect(create).not.toHaveBeenCalled()
  })

  it('retries a quota rejection after release and replays success at full quota', async () => {
    const occupied = box()
    await repository.insert(occupied, 1)
    const key = randomUUID()
    const requested = box()
    const create = jest.fn(async (bind) => {
      await repository.insert(requested, 1, undefined, undefined, undefined, bind)
      return { box_id: requested.id }
    })
    await expect(requests.run(scope, key, { image: 'alpine' }, create)).rejects.toThrow()
    expect(await database.getRepository(Box).count()).toBe(1)
    await database.getRepository(Box).delete(occupied.id)
    const first = await requests.run(scope, key, { image: 'alpine' }, create)
    await expect(requests.run(scope, key, { image: 'alpine' }, create)).resolves.toEqual(first)
    expect(create).toHaveBeenCalledTimes(2)
    expect(await database.getRepository(Box).count()).toBe(1)
  })

  it('rolls back both resource and request binding on an aborted admission transaction', async () => {
    const key = randomUUID()
    const value = box()
    await expect(
      requests.run(scope, key, {}, async (bind) => {
        await repository.insert(value, 1, undefined, undefined, undefined, async (manager, id) => {
          await bind(manager, id)
          throw new Error('abort transaction')
        })
      }),
    ).rejects.toThrow('abort transaction')
    expect(await database.getRepository(Box).count()).toBe(0)
    await requests.run(scope, key, {}, async (bind, id) => {
      expect(id).toBeUndefined()
      await repository.insert(value, 1, undefined, undefined, undefined, bind)
      return { box_id: value.id }
    })
  })

  it('uses a database lock across service instances and releases ownership after failure', async () => {
    const key = randomUUID()
    let entered: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let finish: () => void
    const wait = new Promise<void>((resolve) => {
      finish = resolve
    })
    const first = requests.run(scope, key, {}, async () => {
      entered()
      await wait
      return { id: 'one' }
    })
    await started
    const duplicate = jest.fn()
    try {
      const other = new BoxRequestService(database)
      try {
        await expect(other.run(scope, key, {}, duplicate)).rejects.toMatchObject({ status: 409 })
      } finally {
        await other.onModuleDestroy()
      }
      expect(duplicate).not.toHaveBeenCalled()
    } finally {
      finish()
    }
    await first
    await expect(requests.run(scope, key.toUpperCase(), {}, duplicate)).resolves.toEqual({ id: 'one' })
  })

  it('bounds dedicated lock admission without starving a one-connection business pool', async () => {
    let finish: () => void
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    let entered = 0
    let ready: () => void
    const admitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    const work = Array.from({ length: 4 }, () =>
      requests.run(scope, randomUUID(), {}, async () => {
        expect(await database.query('SELECT 1 AS value')).toEqual([{ value: 1 }])
        if (++entered === 4) ready()
        await barrier
        return { id: 'finished' }
      }),
    )
    await admitted
    try {
      await expect(requests.run(scope, randomUUID(), {}, jest.fn())).rejects.toMatchObject({ status: 503 })
    } finally {
      finish()
    }
    await Promise.all(work)
  })

  it('cleans never-reused expired keys while preserving another instance active ownership', async () => {
    const other = new BoxRequestService(database)
    let finish: () => void
    const barrier = new Promise<void>((resolve) => {
      finish = resolve
    })
    let ready: () => void
    const admitted = new Promise<void>((resolve) => {
      ready = resolve
    })
    const old = requests.run(scope, randomUUID(), {}, async () => {
      ready()
      await barrier
      return { id: 'active' }
    })
    await admitted
    await database.query('UPDATE box_request SET "expiresAt" = now() - interval \'1 second\'')
    try {
      await other.run(scope, randomUUID(), {}, async () => ({ id: 'new' }))
      expect((await database.query('SELECT count(*)::int AS count FROM box_request'))[0].count).toBe(2)
    } finally {
      finish()
      await old
      await other.onModuleDestroy()
    }
    await requests.run(scope, randomUUID(), {}, async () => ({ id: 'cleanup' }))
    expect((await database.query('SELECT count(*)::int AS count FROM box_request'))[0].count).toBe(2)
  })

  it('canonicalizes object order and reuses expired keys as new requests', async () => {
    const key = randomUUID()
    await requests.run(scope, key, { a: 1, nested: { b: 2, a: 3 } }, async () => ({ id: 'first' }))
    const create = jest.fn(async () => ({ id: 'second' }))
    await expect(requests.run(scope, key, { nested: { a: 3, b: 2 }, a: 1 }, create)).resolves.toEqual({ id: 'first' })
    expect(create).not.toHaveBeenCalled()
    await database.query('UPDATE box_request SET "expiresAt" = now() - interval \'1 second\'')
    await expect(requests.run(scope, key, {}, create)).resolves.toEqual({ id: 'second' })
  })
})
