import { BoxRequestService } from '../boxlite-rest/box-request.service'
import { randomUUID } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { ClientRequest, createServer, request, Server, ServerResponse } from 'node:http'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Reflector } from '@nestjs/core'
import { DataSource } from 'typeorm'
import { AuditLog } from './entities/audit-log.entity'
import { AuditService } from './services/audit.service'
import { AuditInterceptor } from './interceptors/audit.interceptor'
import { AuditLogSubscriber } from './subscribers/audit-log.subscriber'
import { BoxliteProxyController } from '../boxlite-rest/boxlite-proxy.controller'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxAutoResumeService } from '../box/services/box-auto-resume.service'
import { TunnelService } from '../box/services/tunnel.service'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AddAuditResponseLease1794300000000 } from '../migrations/pre-deploy/1794300000000-add-audit-response-lease-migration'

jest.mock('http-proxy-middleware', () =>
  process.getBuiltinModule('node:module').createRequire(__filename)('http-proxy-middleware'),
)

const databaseSuite = process.env.DB_HOST ? describe : describe.skip
databaseSuite('response audit lifetime on PostgreSQL', () => {
  let db: DataSource
  let schema: string
  let app: INestApplication
  let upstream: Server
  let upstreamResponse: ServerResponse
  let client: ClientRequest
  let service: AuditService
  let publisher: { write: jest.Mock }
  let forwarded: Promise<void>
  let markForwarded: () => void
  let terminalWrite: Promise<void>
  let markTerminalWrite: () => void
  let leaseAcquired: boolean
  let uploadReceived: Promise<void>

  beforeEach(async () => {
    leaseAcquired = false
    terminalWrite = new Promise((resolve) => (markTerminalWrite = resolve))
    schema = `audit_response_${randomUUID().replaceAll('-', '')}`
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [AuditLog],
      entitySkipConstructor: true,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    new AuditLogSubscriber(db)
    publisher = { write: jest.fn().mockResolvedValue(undefined) }
    service = new AuditService(
      db.getRepository(AuditLog),
      {
        get: () => false,
        getOrThrow: () => 500,
      } as never,
      {
        acquireLease: async () => ({ signal: new AbortController().signal, release: async () => undefined }),
        lock: async () => true,
        unlock: async () => undefined,
      } as never,
      {} as never,
      {} as never,
      publisher,
    )
    const acquire = service.keepPendingLogAlive.bind(service)
    jest.spyOn(service, 'keepPendingLogAlive').mockImplementation(async (id) => {
      const lease = await acquire(id)
      leaseAcquired = true
      return { signal: lease.signal, complete: (result) => lease.complete(result).finally(markTerminalWrite) }
    })
    forwarded = new Promise((resolve) => (markForwarded = resolve))
    upstream = createServer((req, res) => {
      uploadReceived = new Promise((resolve) => req.once('end', resolve))
      req.resume()
      upstreamResponse = res
      markForwarded()
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const module = await Test.createTestingModule({
      controllers: [BoxliteProxyController],
      providers: [
        { provide: BoxRequestService, useValue: {} },
        {
          provide: BoxService,
          useValue: {
            findOneByIdOrName: async () => ({
              id: 'box-id',
              runnerId: 'runner',
              state: 'started',
              desiredState: 'started',
            }),
            updateLastActivityAt: async () => undefined,
          },
        },
        {
          provide: RunnerService,
          useValue: {
            findOne: async () => ({ apiUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }),
          },
        },
        { provide: BoxAutoResumeService, useValue: {} },
        { provide: TunnelService, useValue: {} },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (ctx) => {
          ctx.switchToHttp().getRequest().user = {
            userId: 'actor',
            email: '',
            organizationId: 'org',
            organization: { id: 'org' },
          }
          return true
        },
      })
      .overrideGuard(OrganizationResourceActionGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = module.createNestApplication()
    app.useGlobalInterceptors(new AuditInterceptor(new Reflector(), service))
    await app.listen(0, '127.0.0.1')
  })

  afterEach(async () => {
    client?.destroy()
    upstreamResponse?.destroy()
    upstream?.closeAllConnections()
    await app?.close()
    if (leaseAcquired) await terminalWrite
    if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()))
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  async function upload() {
    const completed = new Promise<number>((resolve, reject) => {
      client = request(
        `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/v1/boxes/box-id/files`,
        { method: 'PUT' },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode!))
        },
      )
      client.on('error', reject)
      client.write('upload-in-progress')
    })
    // Register rejection handling before test cleanup may destroy a pending upload.
    void completed.catch(() => undefined)
    await forwarded
    const [row] = await db.query('SELECT id FROM audit_log')
    await db.query('UPDATE audit_log SET "createdAt" = now() - interval \'40 minutes\' WHERE id = $1', [row.id])
    return { id: row.id as string, completed }
  }

  async function finish(completed: Promise<number>) {
    client.end('last-chunk')
    await uploadReceived
    upstreamResponse.writeHead(204).end()
    expect(await completed).toBe(204)
    await terminalWrite
  }

  it('adds a nullable lease to existing rows and can roll it back', async () => {
    const runner = db.createQueryRunner()
    const migration = new AddAuditResponseLease1794300000000()
    try {
      await migration.down(runner)
      const id = randomUUID()
      await db.query('INSERT INTO audit_log (id, "actorId", action) VALUES ($1, $2, $3)', [id, 'actor', 'create'])
      await migration.up(runner)
      expect(await db.query('SELECT id, "leaseExpiresAt" FROM audit_log')).toEqual([{ id, leaseExpiresAt: null }])
      await migration.down(runner)
      expect(await db.query('SELECT id FROM audit_log')).toEqual([{ id }])
    } finally {
      await runner.release()
    }
  })

  it('keeps an active old upload pending through reconciliation and publishing', async () => {
    const { id, completed } = await upload()
    await service.resolveDanglingLogs()
    await service.publishAuditLogs()
    expect(publisher.write).not.toHaveBeenCalled()
    expect(await db.query('SELECT "statusCode" FROM audit_log WHERE id = $1', [id])).toEqual([{ statusCode: null }])
    await finish(completed)
    expect(await db.query('SELECT "statusCode" FROM audit_log WHERE id = $1', [id])).toEqual([{ statusCode: 204 }])
    await service.publishAuditLogs()
    expect(publisher.write).toHaveBeenCalledWith([expect.objectContaining({ id, statusCode: 204 })])
  })

  it.each([false, true])(
    'does not rewrite or recreate an expired audit after late finish (published: %s)',
    async (publish) => {
      const { id, completed } = await upload()
      await db.query('UPDATE audit_log SET "leaseExpiresAt" = now() - interval \'1 second\' WHERE id = $1', [id])
      await service.resolveDanglingLogs()
      expect(await db.query('SELECT "statusCode" FROM audit_log WHERE id = $1', [id])).toEqual([{ statusCode: 0 }])
      if (publish) await service.publishAuditLogs()
      await finish(completed)
      expect(await db.query('SELECT "statusCode" FROM audit_log WHERE id = $1', [id])).toEqual(
        publish ? [] : [{ statusCode: 0 }],
      )
    },
  )
})
