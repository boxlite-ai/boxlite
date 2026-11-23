import { randomBytes, randomUUID } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import { getRedisConnectionToken } from '@nestjs-modules/ioredis'
import { ExecutionContext, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { Test } from '@nestjs/testing'
import { logs } from '@opentelemetry/api-logs'
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { Logger as PinoLogger, LoggerErrorInterceptor, LoggerModule } from 'nestjs-pino'
import { DataSource } from 'typeorm'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditInterceptor } from '../../audit/interceptors/audit.interceptor'
import { AuditService } from '../../audit/services/audit.service'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { BoxState } from '../enums/box-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { BoxLookupCacheInvalidationService } from '../services/box-lookup-cache-invalidation.service'
import {
  BoxliteOutboundProxyController,
  BoxlitePrefixedOutboundProxyController,
} from '../../boxlite-rest/boxlite-outbound-proxy.controller'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { getPinoRequestOptions } from '../../common/utils/pino.util'
import { useApiBodyParsers } from '../../mcp/mcp-body'
import { IndexBoxOrganizationForProxy1795000000000 } from '../../migrations/pre-deploy/1795000000000-index-box-organization-for-proxy-migration'
import { AddOutboundProxyRegistry1795000001000 } from '../../migrations/pre-deploy/1795000001000-add-outbound-proxy-registry-migration'
import { ExtendOutboundProxyRuntimeState1795153000000 } from '../../migrations/pre-deploy/1795153000000-extend-outbound-proxy-runtime-state-migration'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationUserService } from '../../organization/services/organization-user.service'
import { SystemRole } from '../../user/enums/system-role.enum'
import { ProxyCredentialCipher } from './proxy-credential-cipher'
import { proxyCreate, proxyPatch } from './proxy-registration.input'
import { ProxyRegistryStore } from './proxy-registry.store'

// Jest bypasses the module loader hook that installs PinoInstrumentation in the API process.
jest.mock('pino', () => {
  const { PinoInstrumentation } = jest.requireActual('@opentelemetry/instrumentation-pino')
  const [pino] = new PinoInstrumentation().getModuleDefinitions()
  return pino.patch(jest.requireActual('pino'), jest.requireActual('pino/package.json').version)
})

const describeWithDb = process.env.DB_HOST ? describe : describe.skip
const schema = `proxy_registry_${process.pid}_${randomUUID().replaceAll('-', '')}`
const org = randomUUID()
const otherOrg = randomUUID()
const owner = {
  organizationId: org,
  boxId: 'box-one',
  runnerId: 'runner-one',
  runtimeEpoch: 'epoch-one',
  attemptId: 'attempt-one',
}
const credential = { username: 'test-user', password: 'test-password-not-a-log-field' }
const registration = { name: 'build-egress', url: 'HTTPS://PROXY.EXAMPLE.COM:443/', credential }
const keyA = randomBytes(32).toString('base64')
const keyB = randomBytes(32).toString('base64')

describeWithDb('outbound proxy registry (PostgreSQL)', () => {
  let db: DataSource
  let store: ProxyRegistryStore
  let cipher: ProxyCredentialCipher

  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      extra: { options: `-c search_path=${schema}` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query('CREATE TABLE organization (id uuid PRIMARY KEY)')
    await db.query(`CREATE TABLE box (
      id varchar PRIMARY KEY, "organizationId" uuid NOT NULL, "runnerId" varchar,
      "prevRunnerId" varchar, state varchar, "updatedAt" timestamptz, "outboundControl" jsonb
    )`)
    await db.query('INSERT INTO organization VALUES ($1), ($2)', [org, otherOrg])
    await db.query('INSERT INTO box (id, "organizationId", "runnerId") VALUES ($1, $2, $3)', [
      owner.boxId,
      org,
      owner.runnerId,
    ])
    const migration = db.createQueryRunner()
    try {
      await new IndexBoxOrganizationForProxy1795000000000().up(migration)
      await new AddOutboundProxyRegistry1795000001000().up(migration)
      await new ExtendOutboundProxyRuntimeState1795153000000().up(migration)
    } finally {
      await migration.release()
    }
  })

  afterAll(async () => {
    if (!db?.isInitialized) return
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await db.destroy()
  })

  beforeEach(async () => {
    await db.query('TRUNCATE outbound_proxy_registration, outbound_proxy_key CASCADE')
    await db.query('INSERT INTO outbound_proxy_key_selector DEFAULT VALUES')
    await db.query(
      'UPDATE box SET "runnerId" = $2, "prevRunnerId" = NULL, "outboundControlDueAt" = NULL WHERE id = $1',
      [owner.boxId, owner.runnerId],
    )
    cipher = new ProxyCredentialCipher(JSON.stringify({ a: keyA, b: keyB }))
    store = new ProxyRegistryStore(db, cipher, true)
    await store.activateKey('a')
  })

  async function create() {
    return store.create(org, proxyCreate(registration))
  }

  it('schedules protected previous-Runner cleanup and keeps ownership and its pin', async () => {
    await create()
    await store.reserveReference(owner, registration.name)
    const assignment = {
      id: owner.boxId,
      organizationId: org,
      runnerId: 'replacement-runner',
      prevRunnerId: owner.runnerId,
    }
    await db.query('UPDATE box SET "runnerId" = $2, "prevRunnerId" = $3, state = $4 WHERE id = $1', [
      assignment.id,
      assignment.runnerId,
      assignment.prevRunnerId,
      BoxState.STARTED,
    ])

    const boxes = new BoxRepository(db, new EventEmitter2(), {} as BoxLookupCacheInvalidationService)
    const destroyLegacy = jest.fn()
    await boxes.cleanupPreviousRunner({ ...assignment, runnerId: 'stale-runner' }, destroyLegacy)
    const [unchanged] = await db.query('SELECT "prevRunnerId", "outboundControlDueAt" FROM box WHERE id = $1', [
      owner.boxId,
    ])
    expect(unchanged).toEqual({ prevRunnerId: owner.runnerId, outboundControlDueAt: null })

    await boxes.cleanupPreviousRunner(assignment, destroyLegacy)
    expect(destroyLegacy).not.toHaveBeenCalled()
    const [scheduled] = await db.query('SELECT "prevRunnerId", "outboundControlDueAt" FROM box WHERE id = $1', [
      owner.boxId,
    ])
    expect(scheduled).toEqual({ prevRunnerId: owner.runnerId, outboundControlDueAt: expect.any(Date) })
    await expect(store.remove(org, registration.name)).rejects.toMatchObject({ status: 409 })
  })

  it('pins pre-epoch bootstrap references and retained versions across rollout', async () => {
    await create()
    const [{ id: registrationId }] = await db.query(
      'SELECT id FROM outbound_proxy_registration WHERE organization_id = $1 AND name = $2',
      [org, registration.name],
    )
    const insert = (kind: string, purpose: string, epoch: string | null) =>
      db.query(
        `INSERT INTO outbound_proxy_reference
          (organization_id, box_id, kind, registration_id, revision, runner_id, runtime_epoch, attempt_id, purpose)
          VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8)`,
        [org, owner.boxId, kind, registrationId, owner.runnerId, epoch, owner.attemptId, purpose],
      )

    await expect(insert('pending', 'legacy', null)).rejects.toMatchObject({ code: '23514' })
    await expect(insert('pending', 'bootstrap', '')).rejects.toMatchObject({ code: '23514' })
    await expect(insert('committed', 'bootstrap', null)).rejects.toMatchObject({ code: '23514' })
    await expect(insert('retained', 'update', null)).rejects.toMatchObject({ code: '23514' })
    const reference = await store.reserveBootstrapReference(owner, registration.name)
    expect(reference).toMatchObject({ runtimeEpoch: null, registrationId, revision: 1 })
    await expect(store.remove(org, registration.name)).rejects.toMatchObject({ status: 409 })

    await store.update(org, registration.name, { credential: null })
    await expect(store.retireRevision(org, registration.name, 1)).rejects.toMatchObject({ status: 409 })
    await expect(
      store.confirmBootstrapReference({ ...reference, attemptId: 'different-attempt' }, owner.runtimeEpoch),
    ).rejects.toMatchObject({ status: 409 })
    await store.confirmBootstrapReference(reference, owner.runtimeEpoch)
    await store.confirmBootstrapReference(reference, owner.runtimeEpoch)
    await expect(store.confirmBootstrapReference(reference, 'different-epoch')).rejects.toMatchObject({ status: 409 })
    const [promoted] = await db.query('SELECT kind, runtime_epoch FROM outbound_proxy_reference WHERE box_id = $1', [
      owner.boxId,
    ])
    expect(promoted).toEqual({ kind: 'committed', runtime_epoch: owner.runtimeEpoch })
    await insert('retained', 'update', owner.runtimeEpoch)
    await db.query("DELETE FROM outbound_proxy_reference WHERE kind = 'committed'")
    await expect(store.retireRevision(org, registration.name, 1)).rejects.toMatchObject({ status: 409 })
  })

  it('returns only redacted metadata and scopes all operations to the organization', async () => {
    const created = await create()
    expect(created).toEqual({
      name: registration.name,
      url: 'https://proxy.example.com',
      revision: 1,
      credential_configured: true,
    })
    expect(await store.list(org)).toEqual([created])
    expect(await store.get(org, registration.name)).toEqual(created)
    expect(await store.list(otherOrg)).toEqual([])
    await expect(store.get(otherOrg, registration.name)).rejects.toMatchObject({ status: 404 })
    await expect(store.update(otherOrg, registration.name, { credential: null })).rejects.toMatchObject({ status: 404 })
    await expect(store.remove(otherOrg, registration.name)).rejects.toMatchObject({ status: 404 })
    await expect(
      store.reserveReference({ ...owner, organizationId: otherOrg }, registration.name),
    ).rejects.toMatchObject({ status: 404 })
    await expect(create()).rejects.toMatchObject({ status: 409, message: 'Proxy name already exists' })
    await store.create(otherOrg, proxyCreate({ ...registration, credential: null }))
    await store.remove(org, registration.name)
    expect(await store.list(org)).toEqual([])
    expect(await store.list(otherOrg)).toHaveLength(1)
  })

  it('enforces HTTP scopes and redacts credentials from responses, logs, audits and OTLP records', async () => {
    const createLog = jest.fn().mockResolvedValue({ id: randomUUID() })
    const updateLog = jest.fn().mockResolvedValue(undefined)
    const responses: string[] = []
    const ndjson: string[] = []
    const logStream = new Writable({
      write: (chunk, _encoding, done) => {
        ndjson.push(chunk.toString())
        done()
      },
    })
    const exporter = new InMemoryLogRecordExporter()
    const loggerProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] })
    logs.setGlobalLoggerProvider(loggerProvider)
    const context = await Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: [getPinoRequestOptions(true, 'info'), logStream] })],
      controllers: [BoxliteOutboundProxyController, BoxlitePrefixedOutboundProxyController],
      providers: [
        { provide: ProxyRegistryStore, useValue: store },
        { provide: OrganizationService, useValue: { findOne: async (id: string) => ({ id }) } },
        {
          provide: OrganizationUserService,
          useValue: {
            findOne: async (organizationId: string, identity: string) => {
              const [tenant, access] = identity.split('/')
              if (tenant !== organizationId) return null
              const permissions =
                access === 'writer'
                  ? [OrganizationResourcePermission.WRITE_PROXIES]
                  : access === 'deleter'
                    ? [OrganizationResourcePermission.DELETE_PROXIES]
                    : []
              return { role: OrganizationMemberRole.MEMBER, assignedRoles: [{ permissions }] }
            },
          },
        },
        { provide: getRedisConnectionToken(), useValue: { get: async () => null, set: async () => 'OK' } },
      ],
    })
      .overrideGuard(CombinedAuthGuard)
      .useValue({
        canActivate: (execution: ExecutionContext) => {
          const req = execution.switchToHttp().getRequest()
          const tenant = req.headers['x-test-organization'] ?? org
          req.user = {
            userId: `${tenant}/${req.headers['x-test-access'] ?? 'member'}`,
            organizationId: tenant,
            role: SystemRole.USER,
          }
          return true
        },
      })
      .overrideGuard(AuthenticatedRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile()
    const app: INestApplication = context.createNestApplication({ bodyParser: false, bufferLogs: true })
    app.useLogger(app.get(PinoLogger))
    app.setGlobalPrefix('api')
    useApiBodyParsers(app)
    app.useGlobalInterceptors(
      new LoggerErrorInterceptor(),
      new AuditInterceptor(app.get(Reflector), { createLog, updateLog } as unknown as AuditService),
    )

    try {
      await app.listen(0, '127.0.0.1')
      const { port } = app.getHttpServer().address() as AddressInfo
      const request = async (path: string, init?: RequestInit) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, init)
        responses.push(await response.clone().text())
        return response
      }
      const write = (access: string, body = JSON.stringify(registration)): RequestInit => ({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-access': access },
        body,
      })
      expect((await request('/proxies', write('member'))).status).toBe(403)
      const created = await request(`/${org}/proxies`, write('writer'))
      expect(created.status).toBe(201)
      expect(await created.json()).toEqual({
        name: registration.name,
        url: 'https://proxy.example.com',
        revision: 1,
        credential_configured: true,
      })
      expect(await (await request('/proxies')).json()).toMatchObject({ proxies: [{ name: registration.name }] })
      expect(
        (
          await request('/proxies/build-egress', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', 'x-test-access': 'writer' },
            body: JSON.stringify({ credential: null }),
          })
        ).status,
      ).toBe(200)
      expect((await request(`/${otherOrg}/proxies`)).status).toBe(403)
      expect((await request('/proxies/build-egress', { headers: { 'x-test-organization': otherOrg } })).status).toBe(
        404,
      )
      const invalid = await request(
        '/proxies',
        write(
          'writer',
          JSON.stringify({
            ...registration,
            url: `https://${credential.password}@proxy.example.com`,
          }),
        ),
      )
      expect(invalid.status).toBe(400)
      expect(await invalid.text()).not.toContain(credential.password)
      const seal = jest.spyOn(cipher, 'seal').mockImplementationOnce(() => {
        throw new Error(`Crypto failure with ${credential.username} ${credential.password}`)
      })
      try {
        const failed = await request('/proxies', write('writer'))
        expect(failed.status).toBe(503)
        expect(await failed.json()).toMatchObject({ message: 'Proxy registry unavailable' })
        expect(seal).toHaveBeenCalledTimes(1)
      } finally {
        seal.mockRestore()
      }
      for (const prefix of ['', `/${org}`]) {
        const malformed = await request(`${prefix}/proxies`, write('writer', `{"password":"${credential.password}"`))
        expect(malformed.status).toBe(400)
        expect(await malformed.text()).not.toContain(credential.password)
        expect((await request(`${prefix}/proxies`, write('writer', 'x'.repeat(103000)))).status).toBe(413)
        const wrongType = await request(`${prefix}/proxies/build-egress`, {
          method: 'PATCH',
          headers: { 'content-type': 'text/plain' },
          body: credential.password,
        })
        expect(wrongType.status).toBe(415)
        expect(await wrongType.text()).not.toContain(credential.password)
        const wrongEncoding = await request(`${prefix}/proxies`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'unsupported',
            'x-test-access': 'writer',
          },
          body: JSON.stringify(registration),
        })
        expect(wrongEncoding.status).toBe(415)
      }
      expect(
        (await request('/proxies/build-egress', { method: 'DELETE', headers: { 'x-test-access': 'writer' } })).status,
      ).toBe(403)
      expect(
        (await request('/proxies/build-egress', { method: 'DELETE', headers: { 'x-test-access': 'deleter' } })).status,
      ).toBe(204)
      expect(createLog.mock.calls.map(([log]) => log.action)).toEqual([
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.CREATE,
        AuditAction.CREATE,
        AuditAction.DELETE,
      ])
      expect(updateLog.mock.calls.map(([, log]) => [log.statusCode, log.targetId])).toEqual([
        [201, registration.name],
        [200, registration.name],
        [400, undefined],
        [503, undefined],
        [204, registration.name],
      ])
      await loggerProvider.forceFlush()
      const exported = exporter.getFinishedLogRecords().map(({ body, attributes }) => ({ body, attributes }))
      expect(ndjson.join('')).toContain('/api/v1/proxies')
      expect(exported).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'request errored' })]))

      for (const output of [responses, ndjson, exported, [createLog.mock.calls, updateLog.mock.calls]]) {
        const text = JSON.stringify(output)
        expect(text).not.toContain(credential.password)
        expect(text).not.toContain(credential.username)
        expect(text).not.toContain('ciphertext')
      }
    } finally {
      await app.close()
      await loggerProvider.shutdown()
      logs.disable()
    }
  })

  it('keeps credential omission, explicit clear and new endpoints distinct', async () => {
    await create()
    const second = await store.update(org, registration.name, proxyPatch({ url: 'https://proxy.example.com' }))
    expect(second).toMatchObject({ revision: 2, credential_configured: true })
    await expect(
      store.update(org, registration.name, proxyPatch({ url: 'socks5://proxy.example.com' })),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      store.update(org, registration.name, proxyPatch({ url: 'socks5://new.example.com', credential: null })),
    ).resolves.toMatchObject({ revision: 3, credential_configured: false, url: 'socks5://new.example.com' })
    const rows = await db.query('SELECT envelope FROM outbound_proxy_revision ORDER BY revision')
    expect(rows[0].envelope.nonce).not.toEqual(rows[1].envelope.nonce)
    expect(JSON.stringify(rows)).not.toContain(credential.password)
    expect(JSON.stringify(rows)).not.toContain(credential.username)
    expect(rows[2].envelope).toBeNull()
  })

  it('refuses tampered or wrong-context envelopes without changing the current revision', async () => {
    await create()
    const wrongKey = new ProxyRegistryStore(db, new ProxyCredentialCipher(JSON.stringify({ a: keyB })), true)
    await expect(wrongKey.update(org, registration.name, { url: 'https://proxy.example.com' })).rejects.toMatchObject({
      status: 503,
      message: 'Proxy credential unavailable',
    })
    await db.query("UPDATE outbound_proxy_revision SET url = 'https://other.example.com' WHERE revision = 1")
    await expect(
      store.update(org, registration.name, proxyPatch({ url: 'https://other.example.com' })),
    ).rejects.toMatchObject({ status: 503, message: 'Proxy credential unavailable' })
    expect((await store.get(org, registration.name)).revision).toBe(1)
    await db.query(
      "UPDATE outbound_proxy_revision SET url = 'https://proxy.example.com', envelope = jsonb_set(envelope, '{tag}', to_jsonb($1::text))",
      [Buffer.alloc(16).toString('base64')],
    )
    await expect(
      store.update(org, registration.name, proxyPatch({ url: 'https://proxy.example.com' })),
    ).rejects.toMatchObject({ status: 503 })
    await expect(store.update(org, registration.name, { credential })).resolves.toMatchObject({ revision: 2 })
  })

  it('keeps the applied reference when an update is accepted and protects both reference kinds', async () => {
    await create()
    const pin = await store.reserveReference(owner, registration.name)
    expect(await store.reserveReference(owner, registration.name)).toEqual(pin)
    await expect(
      store.reserveReference({ ...owner, runtimeEpoch: 'changed-epoch' }, registration.name),
    ).rejects.toMatchObject({ status: 409 })
    expect(await store.update(org, registration.name, { credential: null })).toMatchObject({ revision: 2 })
    expect(await db.query('SELECT revision FROM outbound_proxy_reference')).toEqual([{ revision: 1 }])
    expect(await db.query('SELECT rollout_pending FROM outbound_proxy_registration')).toEqual([
      { rollout_pending: true },
    ])
    for (const kind of ['pending', 'committed']) {
      await db.query('UPDATE outbound_proxy_reference SET kind = $1', [kind])
      await expect(store.remove(org, registration.name)).rejects.toMatchObject({ status: 409 })
      await expect(store.retireRevision(org, registration.name, 1)).rejects.toMatchObject({ status: 409 })
      await expect(db.query('DELETE FROM box WHERE id = $1', [owner.boxId])).rejects.toMatchObject({ code: '23503' })
    }
    await db.query('DELETE FROM outbound_proxy_reference')
    await store.retireRevision(org, registration.name, 1)
    await expect(store.retireRevision(org, registration.name, 2)).rejects.toMatchObject({ status: 409 })
    expect(await db.query('SELECT revision FROM outbound_proxy_revision')).toEqual([{ revision: 2 }])
  })

  it('allows only one of deletion and reservation to succeed on the same registration', async () => {
    await create()
    const outcomes = await Promise.allSettled([
      store.remove(org, registration.name),
      store.reserveReference(owner, registration.name),
    ])
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    if (outcomes[0].status === 'rejected') {
      expect(outcomes[0].reason).toMatchObject({ status: 409 })
      expect(await db.query('SELECT revision FROM outbound_proxy_reference')).toEqual([{ revision: 1 }])
    } else {
      expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { status: 404 } })
      expect(await db.query('SELECT revision FROM outbound_proxy_reference')).toEqual([])
    }
  })

  it('re-reads a reservation after an unknown commit reply', async () => {
    await create()
    const createQueryRunner = db.createQueryRunner.bind(db)
    const failure = jest.spyOn(db, 'createQueryRunner').mockImplementationOnce((mode) => {
      const runner = createQueryRunner(mode)
      const commit = runner.commitTransaction.bind(runner)
      runner.commitTransaction = async () => {
        await commit()
        throw new Error('Injected missing commit reply')
      }
      return runner
    })
    try {
      await expect(store.reserveReference(owner, registration.name)).resolves.toMatchObject({ ...owner, revision: 1 })
      expect(await db.query('SELECT revision FROM outbound_proxy_reference')).toEqual([{ revision: 1 }])
    } finally {
      failure.mockRestore()
    }
  })

  it('serializes concurrent patches onto distinct immutable revisions', async () => {
    await create()
    const outcomes = await Promise.all([
      store.update(org, registration.name, { credential }),
      store.update(org, registration.name, { credential: { ...credential, password: 'replacement' } }),
    ])
    expect(outcomes.map(({ revision }) => revision).sort()).toEqual([2, 3])
    expect((await store.get(org, registration.name)).revision).toBe(3)
  })

  it('reads retained keys, reseals an exact pinned revision and rejects retiring a needed key', async () => {
    await create()
    await store.reserveReference(owner, registration.name)
    await store.activateKey('b')
    await expect(store.retireKey('a')).rejects.toMatchObject({ status: 409 })
    const missingKey = new ProxyRegistryStore(db, new ProxyCredentialCipher(JSON.stringify({ b: keyB })), true)
    await expect(missingKey.onModuleInit()).rejects.toMatchObject({ status: 503 })
    await store.resealRevision(org, registration.name, 1)
    expect(await db.query('SELECT key_id, revision FROM outbound_proxy_revision')).toEqual([
      { key_id: 'b', revision: 1 },
    ])
    expect(await db.query('SELECT revision FROM outbound_proxy_reference')).toEqual([{ revision: 1 }])
    await store.retireKey('a')
    await expect(store.activateKey('a')).rejects.toMatchObject({ status: 409 })
    await expect(missingKey.onModuleInit()).resolves.toBeUndefined()
  })

  it('charges a key use on failed registry writes and refuses encryption at the cap', async () => {
    await create()
    await expect(create()).rejects.toMatchObject({ status: 409 })
    expect(await db.query('SELECT uses::integer FROM outbound_proxy_key')).toEqual([{ uses: 2 }])
    await db.query('UPDATE outbound_proxy_key SET uses = 4294967296')
    await expect(store.create(org, proxyCreate({ ...registration, name: 'second' }))).rejects.toMatchObject({
      status: 503,
    })
    expect(await store.list(org)).toHaveLength(1)
    await expect(store.update(org, registration.name, { credential: null })).resolves.toMatchObject({
      credential_configured: false,
    })
  })
})
