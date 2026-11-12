import { BadRequestException, INestApplication, NotFoundException, RequestTimeoutException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import { AddressInfo } from 'node:net'
import { AuditInterceptor } from './interceptors/audit.interceptor'
import { ObjectStorageController } from '../object-storage/controllers/object-storage.controller'
import { ObjectStorageService } from '../object-storage/services/object-storage.service'
import { TypedConfigService } from '../config/typed-config.service'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthenticatedRateLimitGuard } from '../common/guards/authenticated-rate-limit.guard'
import { BoxliteBoxController } from '../boxlite-rest/boxlite-box.controller'
import { BoxService } from '../box/services/box.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CheckpointRecoverService } from '../box/services/checkpoint-recover.service'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'

const mockSend = jest.fn()
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  AssumeRoleCommand: jest.fn().mockImplementation((input) => ({ input })),
}))

describe('audit targets at HTTP boundaries', () => {
  let app: INestApplication
  let base: string
  let box: Box
  let audit: { createLog: jest.Mock; updateLog: jest.Mock }
  let boxes: Record<string, jest.Mock>
  let waitForStarted: jest.Mock
  let createFromCheckpoint: jest.Mock

  beforeEach(async () => {
    mockSend.mockReset().mockResolvedValue({
      Credentials: { AccessKeyId: 'test-access-key', SecretAccessKey: 'test-secret', SessionToken: 'test-token' },
    })
    const config: Record<string, string> = {
      's3.endpoint': 'https://s3.example.test',
      's3.stsEndpoint': 'https://sts.example.test',
      's3.defaultBucket': 'test-bucket',
      's3.region': 'us-east-1',
      's3.accountId': '123456789012',
      's3.roleName': 'test-role',
    }
    box = new Box('us', 'friendly-name')
    box.state = BoxState.STOPPED
    box.desiredState = BoxDesiredState.STOPPED
    audit = { createLog: jest.fn().mockResolvedValue({ id: 'audit' }), updateLog: jest.fn().mockResolvedValue({}) }
    boxes = {
      create: jest.fn().mockResolvedValue(box),
      findOneByIdOrName: jest.fn().mockResolvedValue(box),
      start: jest.fn().mockResolvedValue(box),
      toBoxDto: jest.fn().mockResolvedValue(box),
    }
    waitForStarted = jest
      .fn()
      .mockRejectedValue(new RequestTimeoutException({ message: 'wait expired', boxId: box.id }))
    createFromCheckpoint = jest.fn().mockResolvedValue(box)
    const module = await Test.createTestingModule({
      controllers: [ObjectStorageController, BoxliteBoxController],
      providers: [
        ObjectStorageService,
        {
          provide: TypedConfigService,
          useValue: { get: (key: string) => config[key], getOrThrow: (key: string) => config[key] },
        },
        { provide: BoxService, useValue: boxes },
        { provide: BoxStateWaiterService, useValue: { waitForStarted } },
        { provide: CommerceBoxLimitService, useValue: { resolveMaxCreatedBoxes: async () => 10 } },
        { provide: CheckpointRecoverService, useValue: { createBox: createFromCheckpoint } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = {
            userId: 'user',
            email: 'user@example.test',
            organizationId: 'org',
            organization: { id: 'org' },
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.useGlobalInterceptors(new AuditInterceptor(new Reflector(), audit as never))
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await app?.close()
  })

  it('audits STS issuance for the authenticated organization without recording credentials', async () => {
    const res = await fetch(base + '/object-storage/push-access?organizationId=untrusted')
    expect(res.status).toBe(200)
    const issued = await res.json()
    expect(issued.organizationId).toBe('org')
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(audit.createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'issue_storage_access',
        targetType: 'organization',
        targetId: 'org',
        metadata: null,
      }),
    )
    expect(audit.updateLog).toHaveBeenCalledWith('audit', expect.objectContaining({ statusCode: 200, targetId: 'org' }))
    const recorded = JSON.stringify([audit.createLog.mock.calls, audit.updateLog.mock.calls])
    for (const value of [issued.accessKey, issued.secret, issued.sessionToken]) {
      expect(value).toBeTruthy()
      expect(recorded).not.toContain(value)
    }
  })

  it('does not issue STS credentials if the initial audit insert fails', async () => {
    audit.createLog.mockRejectedValue(new Error('audit unavailable'))
    const res = await fetch(base + '/object-storage/push-access')
    expect(res.status).toBe(500)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('preserves STS failure status while sanitizing the audit error', async () => {
    mockSend.mockRejectedValue(new Error('test-token-in-sts-error'))
    const res = await fetch(base + '/object-storage/push-access')
    expect(res.status).toBe(400)
    expect(audit.updateLog).toHaveBeenCalledWith(
      'audit',
      expect.objectContaining({
        statusCode: 400,
        errorMessage: 'Storage access issuance failed.',
      }),
    )
    expect(JSON.stringify([audit.createLog.mock.calls, audit.updateLog.mock.calls])).not.toContain(
      'test-token-in-sts-error',
    )
  })

  describe.each(['/v1/boxes', '/v1/org/boxes'])('creation command privacy through %s', (path) => {
    it.each(['success', 'starting', 'invalid'])('omits command fields from %s audits', async (outcome) => {
      const cmd = ['tool', '--token=private-command-marker']
      const entrypoint = ['sh', '-c', 'private-entrypoint-marker']
      const body = {
        image: 'alpine:latest',
        cmd: outcome === 'invalid' ? { value: cmd } : cmd,
        entrypoint: outcome === 'invalid' ? { value: entrypoint } : entrypoint,
      }
      if (outcome === 'success') box.state = BoxState.STARTED
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(outcome === 'invalid' ? 400 : 201)
      expect(audit.createLog).toHaveBeenCalledTimes(1)
      const metadata = audit.createLog.mock.calls[0][0].metadata.body
      expect(metadata).toMatchObject({ image: body.image })
      expect(metadata).not.toHaveProperty('cmd')
      expect(metadata).not.toHaveProperty('entrypoint')
      const writes = JSON.stringify([audit.createLog.mock.calls, audit.updateLog.mock.calls])
      expect(writes).not.toContain('private-command-marker')
      expect(writes).not.toContain('private-entrypoint-marker')
      expect(audit.updateLog).toHaveBeenCalledWith('audit', expect.objectContaining({ statusCode: res.status }))
      if (outcome === 'invalid') {
        expect(boxes.create).not.toHaveBeenCalled()
      } else {
        expect(boxes.create).toHaveBeenCalledTimes(1)
        expect(boxes.create.mock.calls[0][0]).toMatchObject({ cmd, entrypoint })
        expect(waitForStarted).not.toHaveBeenCalled()
      }
    })
  })

  it.each(['/v1/boxes', '/v1/org/boxes'])(
    'audits the created Box ID without waiting for startup through %s',
    async (path) => {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: 'alpine:latest' }),
      })
      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({ box_id: box.id })
      expect(boxes.create).toHaveBeenCalledTimes(1)
      expect(waitForStarted).not.toHaveBeenCalled()
      expect(audit.updateLog).toHaveBeenCalledWith(
        'audit',
        expect.objectContaining({ statusCode: 201, targetId: box.id }),
      )
    },
  )
  it('retains the created Box audit target if response conversion fails', async () => {
    Object.defineProperty(box, 'image', {
      configurable: true,
      get: () => {
        throw new Error('DTO conversion failed')
      },
    })
    const res = await fetch(base + '/v1/org/boxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: 'alpine:latest' }),
    })
    expect(res.status).toBe(500)
    expect(audit.updateLog).toHaveBeenCalledWith(
      'audit',
      expect.objectContaining({ statusCode: 500, targetId: box.id }),
    )
    expect(waitForStarted).not.toHaveBeenCalled()
  })

  it('audits the admitted Box ID and checkpoint selector when a checkpoint create wait fails', async () => {
    const res = await fetch(base + '/v1/org/boxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkpoint_id: 'base', name: 'worker' }),
    })
    expect(res.status).toBe(408)
    expect(await res.json()).toMatchObject({ boxId: box.id })
    expect(createFromCheckpoint).toHaveBeenCalledWith({ id: 'org' }, 'base', 'worker', 10)
    expect(boxes.create).not.toHaveBeenCalled()
    expect(audit.createLog.mock.calls[0][0].metadata.body).toMatchObject({ checkpoint_id: 'base', name: 'worker' })
    expect(audit.updateLog).toHaveBeenCalledWith(
      'audit',
      expect.objectContaining({ statusCode: 408, targetId: box.id }),
    )
  })

  it.each(['renamed', 'removed', 'other-organization'])(
    'binds startup to the authorized ID when the resolved Box is %s',
    async (change) => {
      box.organizationId = 'org'
      const replacement = { ...box, id: 'replacement', name: box.id }
      const updateWhere = jest.fn(async (id: string) => ({ ...box, id }))
      const service = Object.create(BoxService.prototype) as BoxService
      Object.assign(service, {
        boxRepository: {
          findOne: jest.fn(async ({ where }) => {
            if (where.name) return replacement
            if (where.id !== box.id || change === 'removed') return null
            return change === 'other-organization' ? { ...box, organizationId: 'other' } : box
          }),
          updateWhere,
        },
        regionService: { findOne: async () => ({}) },
        organizationService: { assertOrganizationIsNotSuspended: jest.fn() },
        eventEmitter: { emit: jest.fn() },
      })
      boxes.start.mockImplementation((...args) => (service.start as any)(...args))
      const res = await fetch(base + '/v1/boxes/friendly-name/start', { method: 'POST' })
      expect(res.status).toBe(change === 'renamed' ? 408 : 404)
      if (change === 'renamed') {
        expect(updateWhere).toHaveBeenCalledWith(box.id, expect.anything())
      } else {
        expect(updateWhere).not.toHaveBeenCalled()
      }
      expect(audit.updateLog).toHaveBeenCalledWith('audit', expect.objectContaining({ targetId: box.id }))
    },
  )

  it.each([false, true])('keeps the resolved ID when startup fails (already starting: %s)', async (alreadyStarting) => {
    if (alreadyStarting) {
      box.state = BoxState.STARTING
      box.desiredState = BoxDesiredState.STARTED
    }
    waitForStarted.mockRejectedValue(new BadRequestException('startup failed'))
    const res = await fetch(base + '/v1/boxes/friendly-name/start', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(boxes.start).toHaveBeenCalledTimes(alreadyStarting ? 0 : 1)
    expect(audit.updateLog).toHaveBeenCalledWith(
      'audit',
      expect.objectContaining({ statusCode: 400, targetId: box.id, errorMessage: 'startup failed' }),
    )
  })

  it('keeps the resolved ID when start fails before waiting', async () => {
    boxes.start.mockRejectedValue(new BadRequestException('cannot start'))
    const res = await fetch(base + '/v1/boxes/friendly-name/start', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(waitForStarted).not.toHaveBeenCalled()
    expect(audit.updateLog).toHaveBeenCalledWith('audit', expect.objectContaining({ targetId: box.id }))
  })

  it('does not invent a resolved ID when the authorized lookup fails', async () => {
    boxes.findOneByIdOrName.mockRejectedValue(new NotFoundException('box missing'))
    const res = await fetch(base + '/v1/boxes/friendly-name/start', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(boxes.start).not.toHaveBeenCalled()
    expect(audit.createLog).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'friendly-name' }))
    expect(audit.updateLog).toHaveBeenCalledWith('audit', expect.objectContaining({ statusCode: 404 }))
    expect(JSON.stringify(audit.updateLog.mock.calls)).not.toContain(box.id)
  })
})
