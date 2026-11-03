/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Test } from '@nestjs/testing'
import { INestApplication, UnauthorizedException } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { Region } from '../../region/entities/region.entity'
import { RegionType } from '../../region/enums/region-type.enum'
import {
  BoxliteCheckpointController,
  BoxliteBoxCheckpointController,
} from '../../boxlite-rest/boxlite-checkpoint.controller'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationUserService } from '../../organization/services/organization-user.service'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { DataSource } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxCheckpoint, BoxCheckpointOperation, BoxCheckpointTransfer } from '../entities/box-checkpoint.entity'
import { Runner } from '../entities/runner.entity'
import { Job } from '../entities/job.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { BoxRepository } from '../repositories/box.repository'
import { BoxCheckpointService, checkpointConfiguration } from './box-checkpoint.service'
import { BoxCheckpointSettler } from './box-checkpoint-settler.service'
import { BoxService } from './box.service'
import { JobService } from './job.service'
import { RunnerAdapterV2 } from '../runner-adapter/runnerAdapter.v2'
import { CheckpointBoxService } from '../../boxlite-rest/checkpoint-box.service'
import { CheckpointTransferService } from '../../boxlite-rest/checkpoint-transfer.service'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'

const databaseTests = process.env.DB_HOST ? describe : describe.skip
const owner = randomUUID(),
  outsider = randomUUID()
const schema = `checkpoint_${process.pid}_${randomUUID().replaceAll('-', '')}`

databaseTests('Memory checkpoint database boundaries', () => {
  let source: DataSource, repository: BoxRepository, checkpoints: BoxCheckpointService, settler: BoxCheckpointSettler
  let app: INestApplication,
    redis: Redis,
    upstream: Server,
    endpoint: string,
    upstreamStatus = 400,
    upstreamInspection: any = null,
    registration: any = null
  let runner: Runner, children: CheckpointBoxService, transfers: CheckpointTransferService
  const archive = { delete: jest.fn().mockResolvedValue(undefined) }
  const admitted = jest.fn()
  let suspended = false
  const organizations = Object.assign(Object.create(OrganizationService.prototype), {
    findOne: async (id: string) => ({ id, suspended }),
  })

  beforeAll(async () => {
    source = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [
        Box,
        BoxLastActivity,
        BoxMigration,
        BoxCheckpoint,
        BoxCheckpointOperation,
        BoxCheckpointTransfer,
        Runner,
        Job,
        Region,
      ],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await source.query(`CREATE SCHEMA "${schema}"`)
    await source.synchronize()
    repository = new BoxRepository(
      source,
      { emit: jest.fn() } as never,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as never,
    )
    const boxes = Object.assign(Object.create(BoxService.prototype), { boxRepository: repository })
    const jobs = new JobService(source.getRepository(Job), { lpush: jest.fn() } as never, {} as never)
    checkpoints = new BoxCheckpointService(
      source,
      boxes,
      repository,
      jobs,
      {
        get: () => ({ archivePrefix: 'gs://checkpoint-test/', maxPerOrganization: 1 }),
      } as never,
      organizations,
    )
    settler = new BoxCheckpointSettler(
      source,
      repository,
      { lock: async () => true, unlock: async () => {} } as never,
      archive,
    )
    children = new CheckpointBoxService(
      checkpoints,
      { create: admitted } as never,
      { resolveMaxCreatedBoxes: async () => 3 } as never,
    )
    transfers = new CheckpointTransferService(source, checkpoints, children, boxes, repository)
    redis = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 56386),
      keyPrefix: schema + ':',
    })
    const module = await Test.createTestingModule({
      controllers: [BoxliteCheckpointController, BoxliteBoxCheckpointController],
      providers: [
        { provide: BoxCheckpointService, useValue: checkpoints },
        { provide: CheckpointBoxService, useValue: children },
        { provide: CheckpointTransferService, useValue: transfers },
        { provide: BoxService, useValue: boxes },
        OrganizationResourceActionGuard,
        Reflector,
        { provide: getRedisConnectionToken(), useValue: redis },
        { provide: OrganizationService, useValue: { findOne: async (id) => ({ id }) } },
        {
          provide: OrganizationUserService,
          useValue: { findOne: async () => ({ role: OrganizationMemberRole.OWNER }) },
        },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (context) => {
          const request = context.switchToHttp().getRequest()
          if (!request.headers.authorization) throw new UnauthorizedException()
          const organizationId = request.headers.authorization === 'Bearer other' ? outsider : owner
          request.user = {
            organizationId,
            userId: 'user',
            apiKey: {
              organizationId,
              permissions:
                request.headers.authorization === 'Bearer read'
                  ? []
                  : [OrganizationResourcePermission.WRITE_BOXES, OrganizationResourcePermission.DELETE_BOXES],
            },
          }
          return true
        },
      })
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    endpoint = 'http://127.0.0.1:' + (app.getHttpServer().address() as AddressInfo).port
    upstream = createServer((request, response) => {
      request.resume()
      if (request.method === 'DELETE') {
        response.writeHead(204).end()
        return
      }
      if (upstreamInspection) {
        if (request.url?.endsWith('/register')) {
          let data = ''
          request.on('data', (chunk) => {
            data += chunk
          })
          request.on('end', () => {
            registration = JSON.parse(data)
            response
              .writeHead(200, { 'Content-Type': 'application/json' })
              .end(JSON.stringify({ checkpointId: '00000000-0000-4000-8000-000000000077' }))
          })
        } else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(upstreamInspection))
        return
      }
      response.writeHead(upstreamStatus, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            type: upstreamStatus === 400 ? 'InvalidArgumentError' : 'StorageError',
            code: upstreamStatus === 400 ? 'invalid_argument' : 'storage_error',
            message: 'native classified failure',
          },
        }),
      )
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  })
  afterAll(async () => {
    if (app) await app.close()
    if (redis) await redis.quit()
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()))
    if (source?.isInitialized) {
      await source.query(`DROP SCHEMA "${schema}" CASCADE`)
      await source.destroy()
    }
  })
  beforeEach(async () => {
    await source.query(
      `TRUNCATE "${schema}"."box", "${schema}"."box_last_activity", "${schema}"."job", "${schema}"."box_checkpoint", "${schema}"."box_checkpoint_operation", "${schema}"."box_checkpoint_transfer", "${schema}"."runner" CASCADE`,
    )
    jest.clearAllMocks()
    suspended = false
    upstreamInspection = null
    registration = null
    await source
      .getRepository(Region)
      .upsert({ id: 'test', name: 'test', regionType: RegionType.SHARED, organizationId: null }, ['id'])
    runner = await source.getRepository(Runner).save({
      apiUrl: 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port,
      name: 'checkpoint-runner',
      region: 'test',
      apiKey: 'test',
      apiVersion: '2',
      state: RunnerState.READY,
      checkpointsEnabled: true,
    })
    admitted.mockImplementation(async (dto, _org, _context, options) => ({
      id: options.initialCheckpointId,
      name: dto.name,
      state: BoxState.PAUSED,
    }))
  })

  async function box(name: string = randomUUID()) {
    const value = new Box('test', name)
    Object.assign(value, {
      organizationId: owner,
      runnerId: runner.id,
      image: 'alpine:3.23',
      osUser: 'boxlite',
      labels: {},
      state: BoxState.PAUSED,
      desiredState: BoxDesiredState.PAUSED,
      pending: false,
      cpu: 1,
      mem: 1,
      disk: 1,
    })
    await source.getRepository(Box).insert(value)
    return value
  }
  async function resource(name: string = randomUUID(), changes: Partial<BoxCheckpoint> = {}) {
    const value = new Box('test')
    value.image = 'alpine:3.23'
    return source.getRepository(BoxCheckpoint).save({
      id: randomUUID(),
      organizationId: owner,
      sourceBoxId: 'source',
      region: 'test',
      name,
      state: 'ready',
      configuration: checkpointConfiguration(value),
      cpus: 1,
      memoryMib: 1024,
      diskGb: 1,
      ...changes,
    })
  }
  async function createFrom(selector: string) {
    return children.create(
      { organizationId: owner, organization: { id: owner } } as never,
      await checkpoints.findOne(owner, selector),
    )
  }

  it('selects an in-scope ID before an identical name for get, child creation and deletion', async () => {
    const a = await resource(),
      b = await resource(a.id)
    expect((await checkpoints.findOne(owner, a.id)).id).toBe(a.id)
    await createFrom(a.id)
    expect(admitted.mock.calls[0][3].initialCheckpointId).toBe(a.id)
    await checkpoints.remove(owner, a.id)
    expect((await source.getRepository(BoxCheckpoint).findOneByOrFail({ id: a.id })).state).toBe('deleting')
    expect((await source.getRepository(BoxCheckpoint).findOneByOrFail({ id: b.id })).state).toBe('ready')
  })
  it('falls back to an exact UUID-shaped name only when the scoped ID is absent', async () => {
    const name = randomUUID(),
      selected = await resource(name)
    expect((await checkpoints.findOne(owner, name)).id).toBe(selected.id)
    await createFrom(name)
    await checkpoints.remove(owner, name)
    expect(admitted.mock.calls[0][3].initialCheckpointId).toBe(selected.id)
    await expect(checkpoints.findOne(owner, ` ${name}`)).rejects.toMatchObject({ status: 404 })
    await resource('CaseSensitive')
    await expect(checkpoints.findOne(owner, 'casesensitive')).rejects.toMatchObject({ status: 404 })
  })
  it.each(['failed', 'deleting'] as const)(
    'never falls back from a selected %s ID to a ready namesake',
    async (state) => {
      const a = await resource(undefined, { state }),
        b = await resource(a.id)
      expect((await checkpoints.findOne(owner, a.id)).id).toBe(a.id)
      await expect(createFrom(a.id)).rejects.toMatchObject({ status: 409 })
      await checkpoints.remove(owner, a.id)
      expect(admitted).not.toHaveBeenCalled()
      expect((await source.getRepository(BoxCheckpoint).findOneByOrFail({ id: b.id })).state).toBe('ready')
    },
  )
  it('applies organization and source scope before ID/name selection and mutations', async () => {
    const outside = await resource(undefined, { organizationId: outsider, sourceBoxId: 'outside' })
    const inside = await resource(outside.id, { sourceBoxId: 'inside' })
    expect((await checkpoints.findOne(owner, outside.id, { sourceBoxId: 'inside' })).id).toBe(inside.id)
    await expect(checkpoints.findOne(owner, outside.id, { sourceBoxId: 'absent' })).rejects.toMatchObject({
      status: 404,
    })
    await createFrom(outside.id)
    await checkpoints.remove(owner, outside.id, { sourceBoxId: 'inside' })
    expect((await source.getRepository(BoxCheckpoint).findOneByOrFail({ id: outside.id })).state).toBe('ready')
    expect(admitted.mock.calls[0][3].initialCheckpointId).toBe(inside.id)
  })
  it('retains a deleting ID after a new resource reuses its old name', async () => {
    const old = await resource('reused', { state: 'deleting' }),
      fresh = await resource('reused')
    expect((await checkpoints.findOne(owner, old.id)).id).toBe(old.id)
    expect((await checkpoints.findOne(owner, 'reused')).id).toBe(fresh.id)
    await expect(createFrom(old.id)).rejects.toMatchObject({ status: 409 })
    await createFrom('reused')
    await checkpoints.remove(owner, old.id)
    expect((await checkpoints.findOne(owner, 'reused')).id).toBe(fresh.id)
  })
  it('serializes concurrent captures at the organization quota and atomically rolls back the losing job', async () => {
    const first = await box(),
      second = await box()
    const result = await Promise.allSettled([
      checkpoints.create(first.id, 'first', owner),
      checkpoints.create(second.id, 'second', owner),
    ])
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(result.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 429 } })
    expect(await source.getRepository(Job).count()).toBe(1)
    expect(await source.getRepository(BoxCheckpointOperation).count()).toBe(1)
    expect(
      await source
        .getRepository(Box)
        .countBy({ checkpointOperationId: (await source.getRepository(BoxCheckpointOperation).find())[0].id }),
    ).toBe(1)
  })
  it('rejects unsupported runners before creating any job or checkpoint', async () => {
    const value = await box()
    await source.getRepository(Runner).update(runner.id, { checkpointsEnabled: false })
    expect(await checkpoints.isEnabled()).toBe(false)
    await expect(checkpoints.create(value.id, 'unsupported', owner)).rejects.toMatchObject({ status: 400 })
    expect(await source.getRepository(Job).count()).toBe(0)
    expect(await source.getRepository(BoxCheckpoint).count()).toBe(0)
  })
  it('settles only native-confirmed matching completion and ignores duplicate or stale callbacks', async () => {
    const value = await box(),
      capture = await checkpoints.create(value.id, 'capture', owner)
    const operation = await source.getRepository(BoxCheckpointOperation).findOneByOrFail({ checkpointId: capture.id })
    const job = await source.getRepository(Job).findOneByOrFail({ id: operation.jobId })
    job.status = JobStatus.COMPLETED
    const result = {
      operationId: operation.id,
      nativeCompleted: false,
      state: 'paused',
      checkpointId: capture.id,
      contentSha256: 'a'.repeat(64),
      bootDiskSha256: 'b'.repeat(64),
      sizeBytes: 4096,
    }
    job.resultMetadata = JSON.stringify(result)
    await settler.settle(job)
    expect((await checkpoints.findOne(owner, capture.id)).state).toBe('creating')
    job.resultMetadata = JSON.stringify({ ...result, nativeCompleted: true, operationId: randomUUID() })
    await settler.settle(job)
    expect((await checkpoints.findOne(owner, capture.id)).state).toBe('creating')
    job.resultMetadata = JSON.stringify({ ...result, nativeCompleted: true })
    await settler.settle(job)
    job.status = JobStatus.FAILED
    await settler.settle(job)
    expect((await checkpoints.findOne(owner, capture.id)).state).toBe('ready')
    expect((await source.getRepository(Box).findOneByOrFail({ id: value.id })).checkpointOperationId).toBeNull()
    await source.getRepository(Box).delete(value.id)
    expect((await checkpoints.findOne(owner, capture.id)).state).toBe('ready')
  })
  it('fails a capture deleted during native work and retains its archive until confirmed completion', async () => {
    const value = await box(),
      capture = await checkpoints.create(value.id, 'deleted', owner)
    const op = await source.getRepository(BoxCheckpointOperation).findOneByOrFail({ checkpointId: capture.id })
    await source.getRepository(Box).update(value.id, { desiredState: BoxDesiredState.DESTROYED })
    await expect(checkpoints.remove(owner, capture.id)).rejects.toMatchObject({ status: 409 })
    const job = await source.getRepository(Job).findOneByOrFail({ id: op.jobId })
    job.status = JobStatus.FAILED
    job.resultMetadata = JSON.stringify({
      operationId: op.id,
      nativeCompleted: true,
      state: 'unknown',
      error: { type: 'StorageError', code: 'storage_error', message: 'write failed' },
    })
    await source.getRepository(Job).save(job)
    await settler.settle(job)
    expect((await checkpoints.findOne(owner, capture.id)).state).toBe('failed')
    expect((await source.getRepository(Box).findOneByOrFail({ id: value.id })).desiredState).toBe(
      BoxDesiredState.DESTROYED,
    )
  })
  it('releases abandoned children only after native work ends, including destroyed children', async () => {
    const checkpoint = await resource(),
      value = await box()
    await source.getRepository(Box).update(value.id, {
      state: BoxState.DESTROYED,
      desiredState: BoxDesiredState.DESTROYED,
      initialCheckpointId: checkpoint.id,
    })
    await settler.reconcile()
    expect((await source.getRepository(Box).findOneByOrFail({ id: value.id })).initialCheckpointId).toBeNull()
    await checkpoints.remove(owner, checkpoint.id)
  })
  it('retries failed archive deletion without reporting resource absence early', async () => {
    const value = await resource('delete', { archiveUri: 'gs://checkpoint-test/delete' })
    await checkpoints.remove(owner, value.id)
    archive.delete.mockRejectedValueOnce(new Error('temporary storage failure'))
    await settler.reconcile()
    expect((await checkpoints.findOne(owner, value.id)).state).toBe('deleting')
    await settler.reconcile()
    await expect(checkpoints.findOne(owner, value.id)).rejects.toMatchObject({ status: 404 })
  })
  it('pins an importing child against deletion until settlement', async () => {
    const checkpoint = await resource(),
      value = await box()
    await source.getRepository(Box).update(value.id, { initialCheckpointId: checkpoint.id })
    await expect(checkpoints.remove(owner, checkpoint.id)).rejects.toMatchObject({ status: 409 })
  })
  it('closes hidden resource admission before requesting native transfer deletion', async () => {
    const checkpoint = await resource(undefined, {
      visible: false,
      nativeRunnerId: runner.id,
      nativeCheckpointId: randomUUID(),
    })
    const transfer = await source.getRepository(BoxCheckpointTransfer).save({
      id: randomUUID(),
      organizationId: owner,
      runnerId: runner.id,
      kind: 'upload',
      state: 'cleanup',
      checkpointId: checkpoint.id,
      expiresAt: new Date(),
    })
    const call = jest.spyOn(transfers as any, 'call').mockImplementation(async () => {
      expect((await source.getRepository(BoxCheckpoint).findOneByOrFail({ id: checkpoint.id })).state).toBe('deleting')
      const child = await box()
      child.initialCheckpointId = checkpoint.id
      await source.getRepository(Box).delete(child.id)
      await expect(repository.insert(child)).rejects.toMatchObject({ status: 409 })
    })
    try {
      await transfers.reap()
    } finally {
      call.mockRestore()
    }
    expect(await source.getRepository(BoxCheckpointTransfer).existsBy({ id: transfer.id })).toBe(false)
  })
  it('serves both prefixes through real organization permission guards and tenant-scoped database selection', async () => {
    const checkpoint = await resource('route')
    for (const prefix of ['', '/default', '/' + owner]) {
      const path = endpoint + '/api/v1' + prefix + '/checkpoints/' + checkpoint.id
      expect((await fetch(path)).status).toBe(401)
      expect((await fetch(path, { headers: { Authorization: 'Bearer other' } })).status).toBe(
        prefix === '/' + owner ? 403 : 404,
      )
      const response = await fetch(path, { headers: { Authorization: 'Bearer owner' } })
      expect(response.status).toBe(200)
      expect((await response.json()).id).toBe(checkpoint.id)
      expect((await fetch(path, { method: 'DELETE', headers: { Authorization: 'Bearer read' } })).status).toBe(403)
      expect(
        (
          await fetch(path + '/boxes', {
            method: 'POST',
            headers: { Authorization: 'Bearer read', 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(403)
    }
    expect(admitted).not.toHaveBeenCalled()
  })
  it.each([400, 500])(
    'preserves the runner %s error envelope through real upload service and HTTP without target or job admission',
    async (status) => {
      upstreamStatus = status
      const response = await fetch(endpoint + '/api/v1/default/boxes/checkpoint/import', {
        method: 'POST',
        headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/octet-stream' },
        body: 'invalid pair',
      })
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({
        error: {
          type: status === 400 ? 'InvalidArgumentError' : 'StorageError',
          code: status === 400 ? 'invalid_argument' : 'storage_error',
          message: 'native classified failure',
        },
      })
      expect(admitted).not.toHaveBeenCalled()
      expect(await source.getRepository(Box).count()).toBe(0)
      expect(await source.getRepository(Job).count()).toBe(0)
      expect(await source.getRepository(BoxCheckpointTransfer).count()).toBe(0)
    },
  )
  it.each([400, 500])('preserves streaming export %s errors before sending success headers', async (status) => {
    upstreamStatus = status
    const value = await box()
    const response = await fetch(endpoint + '/api/v1/boxes/' + value.id + '/checkpoint/export', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner' },
    })
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({
      error: {
        type: status === 400 ? 'InvalidArgumentError' : 'StorageError',
        code: status === 400 ? 'invalid_argument' : 'storage_error',
        message: 'native classified failure',
      },
    })
    expect((await source.getRepository(Box).findOneByOrFail({ id: value.id })).checkpointOperationId).toBeNull()
  })
  it('submits a restore once, reconciles lost completion to Paused, and keeps the source-independent resource', async () => {
    const checkpoint = await resource('restore', {
      contentSha256: 'c'.repeat(64),
      archiveUri: 'gs://checkpoint-test/restore',
    })
    const child = await box()
    await source.getRepository(Box).update(child.id, { state: BoxState.UNKNOWN, initialCheckpointId: checkpoint.id })
    Object.assign(child, { state: BoxState.UNKNOWN, initialCheckpointId: checkpoint.id })
    const jobs = new JobService(source.getRepository(Job), { lpush: jest.fn() } as never, {} as never)
    const adapter = new RunnerAdapterV2(repository, source.getRepository(Job), jobs)
    await adapter.init(runner)
    await adapter.createBox(child, checkpoint.configuration.image)
    await adapter.createBox(child, checkpoint.configuration.image)
    expect(await source.getRepository(Job).count()).toBe(1)
    const operation = await source.getRepository(BoxCheckpointOperation).findOneByOrFail({ boxId: child.id })
    const job = await source.getRepository(Job).findOneByOrFail({ id: operation.jobId })
    expect(job.getPayload()).toMatchObject({
      operationId: operation.id,
      checkpointId: checkpoint.id,
      organizationId: owner,
    })
    job.status = JobStatus.COMPLETED
    job.completedAt = new Date()
    job.resultMetadata = JSON.stringify({ operationId: operation.id, nativeCompleted: true, state: 'paused' })
    await source.getRepository(Job).save(job)
    await settler.reconcile()
    expect(await source.getRepository(Box).findOneByOrFail({ id: child.id })).toMatchObject({
      state: BoxState.PAUSED,
      desiredState: BoxDesiredState.PAUSED,
      initialCheckpointId: null,
      checkpointOperationId: null,
    })
    expect((await checkpoints.findOne(owner, checkpoint.id)).state).toBe('ready')
    await checkpoints.remove(owner, checkpoint.id)
  })
  it.each([
    ['pause', 400, 'InvalidArgumentError', 'invalid_argument'],
    ['resume', 500, 'StorageError', 'storage_error'],
  ] as const)(
    'records accepted %s failure and preserves its structured HTTP category',
    async (kind, status, type, code) => {
      const value = await box()
      if (kind === 'pause')
        await source
          .getRepository(Box)
          .update(value.id, { state: BoxState.STARTED, desiredState: BoxDesiredState.STARTED })
      const responsePromise = fetch(endpoint + '/api/v1/boxes/' + value.id + '/' + kind, {
        method: 'POST',
        headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: '{}',
      })
      let job: Job | null = null
      const deadline = Date.now() + 2000
      while (!job && Date.now() < deadline) {
        job = await source.getRepository(Job).findOneBy({ resourceId: value.id })
        if (!job) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      if (!job) throw new Error('Checkpoint operation did not submit its job')
      job.status = JobStatus.FAILED
      job.resultMetadata = JSON.stringify({
        operationId: job.getPayload()?.operationId,
        nativeCompleted: true,
        state: kind === 'pause' ? 'started' : 'paused',
        error: { type, code, message: 'native failure after admission' },
      })
      await source.getRepository(Job).save(job)
      await settler.settle(job)
      const response = await responsePromise
      expect(response.status).toBe(status)
      expect(await response.json()).toEqual({ error: { type, code, message: 'native failure after admission' } })
      expect((await source.getRepository(BoxCheckpointOperation).findOneByOrFail({ jobId: job.id })).state).toBe(
        'failed',
      )
      expect(await source.getRepository(Box).count()).toBe(1)
    },
  )
  it('rejects an unacknowledged native lease even when the job is failed or an acknowledgement is truthy', async () => {
    const value = await box(),
      checkpoint = await checkpoints.create(value.id, 'lease', owner)
    const operation = await source
      .getRepository(BoxCheckpointOperation)
      .findOneByOrFail({ checkpointId: checkpoint.id })
    const job = await source.getRepository(Job).findOneByOrFail({ id: operation.jobId })
    job.status = JobStatus.FAILED
    job.resultMetadata = JSON.stringify({ operationId: operation.id, nativeCompleted: 'true', state: 'unknown' })
    await settler.settle(job)
    expect((await source.getRepository(BoxCheckpointOperation).findOneByOrFail({ id: operation.id })).state).toBe(
      'pending',
    )
    await expect(checkpoints.remove(owner, checkpoint.id)).rejects.toMatchObject({ status: 409 })
  })
  it('persists only the inspected allowlist and admits the same network/resources before creating a pinned Paused target', async () => {
    const captured = await box(),
      configuration = checkpointConfiguration(captured)
    configuration.outbound = { mode: 'enabled', allow_net: ['example.com'] }
    upstreamInspection = {
      version: 1,
      pair_sha256: 'd'.repeat(64),
      boot_disk_sha256: 'e'.repeat(64),
      boot_disk_bytes: 4096,
      memory_file_bytes: 4096,
      qcow2_bytes: 4096,
      container_disk_bytes: 1024 ** 3,
      resources: { cpus: 1, memory_mib: 1024, max_cpus: 2, max_memory_mib: 2048, host_path: '/untrusted' },
      configuration: { ...configuration, security: { disabled: true }, host_path: '/untrusted' },
      host_path: '/untrusted',
    }
    await resource('wrong-org-boot', {
      organizationId: outsider,
      bootDiskSha256: 'e'.repeat(64),
      archiveUri: 'gs://private-other-org/boot',
    })
    const boot = await resource('same-org-boot', {
      bootDiskSha256: 'e'.repeat(64),
      archiveUri: 'gs://checkpoint-test/trusted-boot',
    })
    let leaseId: string | undefined
    admitted.mockImplementation(async (dto, org, _context, options) => {
      expect(dto).toMatchObject({
        cpu: 1,
        memory: 1,
        disk: 1,
        autoResume: false,
        outboundEnabled: true,
        outboundAllowNet: ['example.com'],
      })
      const lease = await source
        .getRepository(BoxCheckpointTransfer)
        .findOneByOrFail({ checkpointId: options.initialCheckpointId })
      leaseId = lease.id
      expect(lease.inspection).toEqual({
        version: 1,
        pair_sha256: 'd'.repeat(64),
        boot_disk_sha256: 'e'.repeat(64),
        boot_disk_bytes: 4096,
        memory_file_bytes: 4096,
        qcow2_bytes: 4096,
        container_disk_bytes: 1024 ** 3,
        resources: { cpus: 1, memory_mib: 1024, max_cpus: 2, max_memory_mib: 2048 },
        configuration,
      })
      const value = new Box('test', dto.name)
      Object.assign(value, {
        organizationId: org.id,
        image: dto.image,
        osUser: 'boxlite',
        labels: {},
        initialCheckpointId: options.initialCheckpointId,
        state: BoxState.UNKNOWN,
        desiredState: BoxDesiredState.PAUSED,
        cpu: dto.cpu,
        mem: dto.memory,
        disk: dto.disk,
        autoResume: dto.autoResume,
      })
      await repository.insert(value)
      return { ...value, memory: value.mem }
    })
    const response = await fetch(endpoint + '/api/v1/boxes/checkpoint/import?name=uploaded', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/octet-stream' },
      body: 'runner-inspected-pair-fixture',
    })
    expect(response.status).toBe(201)
    expect(registration).toEqual({
      organizationId: owner,
      operationId: leaseId,
      expectedPairSha256: 'd'.repeat(64),
      bootArchiveUri: boot.archiveUri,
    })
    const lease = await source.getRepository(BoxCheckpointTransfer).findOneByOrFail({ id: leaseId })
    expect(lease.state).toBe('consumed')
    if (!lease.targetBoxId) throw new Error('Consumed transfer has no target')
    expect((await source.getRepository(Box).findOneByOrFail({ id: lease.targetBoxId })).desiredState).toBe(
      BoxDesiredState.PAUSED,
    )
    await transfers.reap()
    expect(await source.getRepository(BoxCheckpointTransfer).existsBy({ id: leaseId })).toBe(true)
  })
  it('retains failed native cleanup leases for retry and never releases staging on expiration alone', async () => {
    const transfer = await source.getRepository(BoxCheckpointTransfer).save({
      id: randomUUID(),
      organizationId: owner,
      runnerId: runner.id,
      kind: 'upload',
      state: 'staging',
      expiresAt: new Date(0),
    })
    const call = jest
      .spyOn(transfers as any, 'call')
      .mockRejectedValueOnce(new Error('native still using staging'))
      .mockResolvedValueOnce(undefined)
    try {
      await transfers.reap()
      expect(await source.getRepository(BoxCheckpointTransfer).existsBy({ id: transfer.id })).toBe(true)
      await transfers.reap()
      expect(await source.getRepository(BoxCheckpointTransfer).existsBy({ id: transfer.id })).toBe(false)
    } finally {
      call.mockRestore()
    }
  })
  it('scopes same-organization ID collisions to the requested source before deletion', async () => {
    const outside = await resource('outside-source', { sourceBoxId: 'outside' })
    const inside = await resource(outside.id, { sourceBoxId: 'inside' })
    expect((await checkpoints.findOne(owner, outside.id, { sourceBoxId: 'inside' })).id).toBe(inside.id)
    await checkpoints.remove(owner, outside.id, { sourceBoxId: 'inside' })
    expect((await checkpoints.findOne(owner, outside.id)).id).toBe(outside.id)
    expect((await source.getRepository(BoxCheckpoint).findOneByOrFail({ id: outside.id })).state).toBe('ready')
  })
  it.each([{ name: '' }, { name: null }, { name: ' space' }, { name: 'bad/name' }, { summary: {} }])(
    'validates checkpoint name/body %j before job admission',
    async (body) => {
      const value = await box()
      const response = await fetch(endpoint + '/api/v1/default/boxes/' + value.id + '/checkpoints', {
        method: 'POST',
        headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      expect(await source.getRepository(Job).count()).toBe(0)
      expect(await source.getRepository(BoxCheckpoint).count()).toBe(0)
    },
  )
  it('rejects parsed JSON at the raw binary boundary without allocating a transfer', async () => {
    const response = await fetch(endpoint + '/api/v1/boxes/checkpoint/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(400)
    expect(await source.getRepository(BoxCheckpointTransfer).count()).toBe(0)
  })
  it('advertises support only with configured storage and a schedulable compatible runner', async () => {
    expect(await checkpoints.isEnabled()).toBe(true)
    await source.getRepository(Runner).update(runner.id, { draining: true })
    expect(await checkpoints.isEnabled()).toBe(false)
    await source.getRepository(Runner).update(runner.id, { draining: false, apiVersion: '0' })
    expect(await checkpoints.isEnabled()).toBe(false)
    const disabled = new BoxCheckpointService(
      source,
      {} as never,
      repository,
      {} as never,
      { get: () => ({ maxPerOrganization: 1 }) } as never,
      organizations,
    )
    expect(await disabled.isEnabled()).toBe(false)
    await expect(disabled.create('source', 'name', owner)).rejects.toMatchObject({ status: 400 })
    expect(await source.getRepository(Job).count()).toBe(0)
  })
  it('admits deletion of a restoring target while retaining its native operation and resource lease', async () => {
    const checkpoint = await resource('live-restore'),
      child = await box(),
      operationId = randomUUID()
    await source.getRepository(Box).update(child.id, {
      state: BoxState.RESTORING,
      initialCheckpointId: checkpoint.id,
      checkpointOperationId: operationId,
    })
    const current = await source.getRepository(Box).findOneByOrFail({ id: child.id })
    const removed = await repository.updateWhere(child.id, {
      updateData: Box.getSoftDeleteUpdate(current),
      whereCondition: { state: BoxState.RESTORING, pending: false },
    })
    expect(removed).toMatchObject({
      desiredState: BoxDesiredState.DESTROYED,
      initialCheckpointId: checkpoint.id,
      checkpointOperationId: operationId,
    })
    await expect(checkpoints.remove(owner, checkpoint.id)).rejects.toMatchObject({ status: 409 })
  })
  it('applies ordinary organization suspension policy before resuming a Paused VM', async () => {
    const value = await box()
    suspended = true
    const response = await fetch(endpoint + '/api/v1/boxes/' + value.id + '/resume', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner' },
    })
    expect(response.status).toBe(403)
    expect(await source.getRepository(Job).count()).toBe(0)
    expect((await source.getRepository(Box).findOneByOrFail({ id: value.id })).desiredState).toBe(
      BoxDesiredState.PAUSED,
    )
  })
})
