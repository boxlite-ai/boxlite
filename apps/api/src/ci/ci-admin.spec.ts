/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PassportModule } from '@nestjs/passport'
import { AddressInfo } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AuditLog } from '../audit/entities/audit-log.entity'
import { ApiKeyStrategy } from '../auth/api-key.strategy'
import { JwtStrategy } from '../auth/jwt.strategy'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { AddCiConnect1793664000000 } from '../migrations/pre-deploy/1793664000000-add-ci-connect-migration'
import { AddCiListenerState1793700000000 } from '../migrations/pre-deploy/1793700000000-add-ci-listener-state-migration'
import { AddCiWebConnect1793786400000 } from '../migrations/pre-deploy/1793786400000-add-ci-web-connect-migration'
import { AddCiAccountSelection1793894400000 } from '../migrations/pre-deploy/1793894400000-add-ci-account-selection-migration'
import { AddCiWebTarget1794000000000 } from '../migrations/pre-deploy/1794000000000-add-ci-web-target-migration'
import { AddCiAdminAuthority1794873600000 } from '../migrations/pre-deploy/1794873600000-add-ci-admin-authority-migration'
import { AddCiAdminIndexes1794873600001 } from '../migrations/pre-deploy/1794873600001-add-ci-admin-indexes-migration'
import { CiAdminController } from './ci-admin.controller'
import { CiAdminService } from './ci-admin.service'
import { CiNativeState } from './ci-native-state'
import { CiSettingsService } from './ci-settings.service'

const integration = process.env.DB_HOST ? describe : describe.skip
integration('CI administrator HTTP + PostgreSQL contract', () => {
  const schema = 'ci_admin_' + randomUUID().replaceAll('-', '')
  const organizations = [randomUUID(), randomUUID(), randomUUID()]
  const [issuer, first, second] = organizations
  const input = { github_account: 'alice', account_type: 'User', allow_private_repositories: false }
  const hash = (token: string) => createHash('sha256').update(token).digest('hex')
  const cache = new Map<string, string>()
  const redis = {
    get: async (key: string) => cache.get(key) ?? null,
    setex: async (key: string, _ttl: number, value: string) => {
      cache.set(key, value)
    },
  }
  const statements: { sql: string; parameters: any[] }[] = []
  let db: DataSource,
    native: CiNativeState,
    service: CiAdminService,
    settings: CiSettingsService,
    app: INestApplication,
    base: string
  let verifyInstallation: jest.SpyInstance
  const path = (org = first, id?: string) => `/organizations/${org}/ci/connections${id ? '/' + id : ''}`
  const lookup = '/ci/connections?account_type=User&github_account=ALICE'
  async function request(url = path(), method = 'GET', body?: unknown, token = 'admin-key') {
    return fetch(base + url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  async function create(org = first) {
    const response = await request(path(org), 'POST', input)
    expect(response.status).toBe(201)
    return response.json() as Promise<any>
  }
  async function replace(binding: any, org = second) {
    const response = await request(path(org), 'POST', {
      ...input,
      force: true,
      expected_binding_id: binding.binding_id,
      expected_generation: binding.generation,
    })
    expect(response.status).toBe(200)
    return response.json() as Promise<any>
  }
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '::1'].includes(process.env.DB_HOST!))
      throw Error('Disposable local database required')
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      entities: [AuditLog],
      entitySkipConstructor: true,
      extra: { options: `-c search_path=${schema},public` },
      logging: ['query'],
      logger: {
        logQuery: (sql, parameters) => {
          statements.push({ sql, parameters: parameters ?? [] })
        },
        logQueryError() {},
        logQuerySlow() {},
        logSchemaBuild() {},
        logMigration() {},
        log() {},
      },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}";
      CREATE TABLE organization(id uuid PRIMARY KEY,name text,suspended boolean DEFAULT false,"suspendedUntil" timestamptz);
      CREATE TABLE "user"(id text PRIMARY KEY,role text,email text);
      CREATE TABLE organization_user("organizationId" uuid,"userId" text,role text);
      CREATE TABLE api_key("keyHash" text PRIMARY KEY,"organizationId" uuid,"userId" text,permissions text[],"expiresAt" timestamptz)`)
    await db.synchronize()
    const runner = db.createQueryRunner()
    try {
      for (const migration of [
        new AddCiConnect1793664000000(),
        new AddCiListenerState1793700000000(),
        new AddCiWebConnect1793786400000(),
        new AddCiAccountSelection1793894400000(),
        new AddCiWebTarget1794000000000(),
        new AddCiAdminAuthority1794873600000(),
        new AddCiAdminIndexes1794873600001(),
      ])
        await migration.up(runner)
    } finally {
      await runner.release()
    }
    const keyService = {
      getApiKeyByValue: async (token: string) => {
        const [key] = await db.query('SELECT * FROM api_key WHERE "keyHash"=$1', [hash(token)])
        if (!key) throw Error('Unknown key')
        return { ...key, name: 'fixture' }
      },
      updateLastUsedAt: async () => undefined,
    }
    const users = { findOne: async (id: string) => (await db.query('SELECT * FROM "user" WHERE id=$1', [id]))[0] }
    native = new CiNativeState(db, {
      get: (key: string) => (key === 'ci.githubClientId' ? 'test-app' : undefined),
    } as any)
    settings = new CiSettingsService(native, { resolveMaxCreatedBoxes: async () => 5 } as any)
    service = new CiAdminService(native, settings)
    verifyInstallation = jest.spyOn(native.registry.forType('User'), 'verifyInstalledAccount')
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [CiAdminController],
      providers: [
        { provide: CiAdminService, useValue: service },
        CombinedAuthGuard,
        {
          provide: JwtStrategy,
          useFactory: () =>
            new JwtStrategy(
              { jwksUri: 'https://example.test/jwks', audience: 'test', issuer: 'https://example.test' },
              users as any,
              {} as any,
              {} as any,
            ),
        },
        {
          provide: ApiKeyStrategy,
          useFactory: () =>
            new ApiKeyStrategy(
              redis as any,
              keyService as any,
              users as any,
              { get: (key: string) => (key === 'proxy.apiKey' ? 'proxy-key' : undefined) } as any,
              {} as any,
              {} as any,
            ),
        },
      ],
    }).compile()
    app = module.createNestApplication({ logger: false })
    app.setGlobalPrefix('api')
    await app.listen(0, '127.0.0.1')
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/admin`
  })
  beforeEach(async () => {
    cache.clear()
    await db.query(
      'TRUNCATE organization,"user",organization_user,api_key,ci_installation_binding,ci_connect_attempt,ci_listener_state,audit_log CASCADE',
    )
    await db.query("INSERT INTO organization(id,name) VALUES($1,'Issuer'),($2,'First'),($3,'Second')", organizations)
    await db.query(
      "INSERT INTO \"user\" VALUES('admin','admin','admin@example.test'),('owner','user','owner@example.test')",
    )
    for (const [token, user] of [
      ['admin-key', 'admin'],
      ['owner-key', 'owner'],
    ])
      await db.query("INSERT INTO api_key VALUES($1,$2,$3,'{}',NULL)", [hash(token), issuer, user])
    await native.initialize()
    await settings.initialize()
    verifyInstallation
      .mockReset()
      .mockResolvedValue({ installationId: 10, accountId: 20, accountLogin: 'alice', accountType: 'User' })
    statements.length = 0
  })
  afterAll(async () => {
    await app?.close()
    await native?.onApplicationShutdown()
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })
  it('creates without either organization membership or OAuth; reads, updates and disables the retained connection', async () => {
    const binding = await create()
    expect(binding).toMatchObject({
      organization_id: first,
      organization_name: 'First',
      generation: '1',
      admin_managed: true,
      github_account_id: '20',
      installation_id: '10',
    })
    expect((await (await request(lookup)).json()).items).toEqual([binding])
    expect((await (await request()).json()).items).toEqual([binding])
    const updated = await request(path(first, binding.binding_id), 'PATCH', {
      expected_generation: '1',
      allow_private_repositories: true,
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ generation: '2', allow_private_repositories: true })
    expect((await request(path(first, binding.binding_id), 'DELETE', { expected_generation: '2' })).status).toBe(204)
    expect((await (await request(lookup)).json()).items[0]).toMatchObject({
      listener_status: 'disabled',
      generation: '3',
    })
    const logs = await db.getRepository(AuditLog).find({ order: { createdAt: 'ASC' } })
    expect(logs.map((log) => log.action)).toEqual(['create', 'update', 'delete'])
    expect(logs[0]).toMatchObject({
      actorId: 'admin',
      organizationId: first,
      metadata: { before: null, after: binding },
    })
    expect(JSON.stringify(logs)).not.toContain(hash('admin-key'))
  })
  it('requires real admin authority and rechecks cached roles, revoked and expired keys', async () => {
    expect((await request(path(), 'POST', input, 'owner-key')).status).toBe(403)
    expect((await request(path(), 'POST', input, 'proxy-key')).status).toBe(403)
    expect((await request(path(), 'POST', input, 'unknown-key')).status).toBe(401)
    await create()
    await db.query("UPDATE \"user\" SET role='user' WHERE id='admin'")
    expect((await request(lookup)).status).toBe(403)
    await db.query("UPDATE \"user\" SET role='admin' WHERE id='admin'")
    await db.query('UPDATE api_key SET "expiresAt"=clock_timestamp()-interval \'1 second\'')
    expect((await request(lookup)).status).toBe(403)
    await db.query('DELETE FROM api_key')
    expect((await request(lookup)).status).toBe(403)
  })
  it('requires explicit CAS for replacement, including same-target retries and disabled history', async () => {
    const binding = await create()
    for (const org of [first, second]) {
      const response = await request(path(org), 'POST', input)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        connection: { binding_id: binding.binding_id, generation: '1', organization_id: first },
      })
    }
    const moved = await replace(binding)
    expect(moved).toMatchObject({ binding_id: binding.binding_id, organization_id: second, generation: '2' })
    expect(
      (
        await request(path(), 'POST', {
          ...input,
          force: true,
          expected_binding_id: binding.binding_id,
          expected_generation: '1',
        })
      ).status,
    ).toBe(409)
    const back = await replace(moved, first)
    expect(
      (await request(path(first, back.binding_id), 'DELETE', { expected_generation: binding.generation })).status,
    ).toBe(409)
    expect(
      (
        await request(path(first, back.binding_id), 'PATCH', {
          expected_generation: '1',
          allow_private_repositories: true,
        })
      ).status,
    ).toBe(409)
    expect(
      (await request(path(first, back.binding_id), 'DELETE', { expected_generation: back.generation })).status,
    ).toBe(204)
    expect((await request(path(), 'POST', input)).status).toBe(409)
    const quotas = await native.state.read(['quota/' + first, 'quota/' + second])
    expect(quotas).toHaveLength(2)
  })
  it('allows only one of two concurrent creations and stale replacements', async () => {
    const created = await Promise.all([request(path(), 'POST', input), request(path(second), 'POST', input)])
    expect(created.map((r) => r.status).sort()).toEqual([201, 409])
    const binding = await created.find((r) => r.status === 201)!.json()
    const body = {
      ...input,
      force: true,
      expected_binding_id: binding.binding_id,
      expected_generation: binding.generation,
    }
    const replaced = await Promise.all([request(path(first), 'POST', body), request(path(second), 'POST', body)])
    expect(replaced.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await db.getRepository(AuditLog).count()).toBe(2)
  })
  it('retains old installation identity on reinstall and rejects ambiguous current-installation claims', async () => {
    const before = await create()
    verifyInstallation.mockResolvedValue({
      installationId: 11,
      accountId: 20,
      accountLogin: 'alice',
      accountType: 'User',
    })
    const after = await replace(before)
    expect(after.binding_id).not.toBe(before.binding_id)
    expect(after.installation_id).toBe('11')
    const history = (await (await request(lookup)).json()).items
    expect(history).toHaveLength(2)
    expect(history.find((row: any) => row.binding_id === before.binding_id)).toMatchObject({
      installation_id: '10',
      organization_id: first,
      listener_status: 'disabled',
      generation: '2',
    })
    verifyInstallation.mockResolvedValue({
      installationId: 10,
      accountId: 20,
      accountLogin: 'alice',
      accountType: 'User',
    })
    expect(
      (
        await request(path(), 'POST', {
          ...input,
          force: true,
          expected_binding_id: after.binding_id,
          expected_generation: after.generation,
        })
      ).status,
    ).toBe(409)
    expect(await db.getRepository(AuditLog).count()).toBe(2)
  })
  it('fences old scopes after transfer and retains admission when the audited creator disappears', async () => {
    const binding = await create()
    const scope = {
      binding: binding.binding_id,
      generation: 1,
      organization: first,
      actor: 'admin',
      installation: { id: 10, account: { id: 20, login: 'alice', type: 'User' as const } },
      runners: { allowPublic: true, allowPrivate: false },
    }
    await db.query('DELETE FROM "user" WHERE id=\'admin\'')
    await expect(native.transaction((tx) => native.admit(tx, scope, 'test-app'))).resolves.toBeUndefined()
    await db.query("INSERT INTO \"user\" VALUES('admin','admin','admin@example.test')")
    const moved = await replace(binding)
    await expect(native.transaction((tx) => native.admit(tx, scope, 'test-app'))).rejects.toThrow('no longer active')
    await expect(
      native.transaction((tx) =>
        native.admit(tx, { ...scope, generation: Number(moved.generation), organization: second }, 'test-app'),
      ),
    ).resolves.toBeUndefined()
  })
  it('preserves the source quota and refuses ambiguous active history without an audit or mapping change', async () => {
    const binding = await create()
    await settings.update({ organizationId: first, userId: 'admin' }, 2)
    const before = (await native.state.read(['quota/' + first]))[0]
    const moved = await replace(binding)
    expect((await native.state.read(['quota/' + first]))[0]).toEqual(before)
    await db.query(
      `INSERT INTO ci_installation_binding
      (id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation)
      VALUES(gen_random_uuid(),'github.com','test-app',11,20,'alice','User',$1,'owner',true)`,
      [first],
    )
    const rows = await db.query('SELECT * FROM ci_installation_binding ORDER BY id')
    expect(
      (
        await request(path(), 'POST', {
          ...input,
          force: true,
          expected_binding_id: moved.binding_id,
          expected_generation: moved.generation,
        })
      ).status,
    ).toBe(409)
    expect(await db.query('SELECT * FROM ci_installation_binding ORDER BY id')).toEqual(rows)
    expect(await db.getRepository(AuditLog).count()).toBe(2)
  })
  it('rechecks role revocation after external App verification before creating authority', async () => {
    verifyInstallation.mockImplementation(async () => {
      await db.query("UPDATE \"user\" SET role='user' WHERE id='admin'")
      return { installationId: 10, accountId: 20, accountLogin: 'alice', accountType: 'User' }
    })
    expect((await request(path(), 'POST', input)).status).toBe(403)
    expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
    expect(await db.getRepository(AuditLog).count()).toBe(0)
  })
  it('rolls back the binding and audit together if the verified credential expires before commit', async () => {
    const wake = jest.spyOn(native, 'wakeInventory').mockImplementation(async (tx) => {
      await tx.query('UPDATE api_key SET "expiresAt"=clock_timestamp()-interval \'1 second\'')
    })
    try {
      expect((await request(path(), 'POST', input)).status).toBe(403)
      expect(await db.query('SELECT * FROM ci_installation_binding')).toHaveLength(0)
      expect(await db.getRepository(AuditLog).count()).toBe(0)
    } finally {
      wake.mockRestore()
    }
  })
  it('rejects unbounded lookup, malformed versions, unknown fields and unavailable targets before verification', async () => {
    for (const query of [
      '',
      '?github_account=alice',
      '?account_type=User',
      '?account_type=User&github_account=alice&github_account_id=20',
      '?account_type=User&github_account=alice&limit=101',
      '?account_type=User&github_account=alice&cursor=x',
    ])
      expect((await request('/ci/connections' + query)).status).toBe(400)
    for (const extra of [
      { force: 'true' },
      { force: null },
      { force: true },
      { actor_id: 'owner' },
      { expected_generation: '1' },
    ])
      expect((await request(path(), 'POST', { ...input, ...extra })).status).toBe(400)
    expect((await request(path(randomUUID()), 'POST', input)).status).toBe(404)
    await db.query('UPDATE organization SET suspended=true WHERE id=$1', [first])
    expect((await request(path(), 'POST', input)).status).toBe(403)
    expect(verifyInstallation).not.toHaveBeenCalled()
  })
  it('paginates retained records with the deployed indexes using captured production SQL', async () => {
    await db.query(`INSERT INTO organization(id,name) SELECT gen_random_uuid(),'Fixture' FROM generate_series(1,1000)`)
    await db.query(`INSERT INTO ci_installation_binding
      (id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation)
      SELECT gen_random_uuid(),'github.com','test-app',row_number() OVER(),n,'account-'||n,'User',o.id,'owner',true
      FROM (SELECT id FROM organization ORDER BY id LIMIT 1000) o CROSS JOIN generate_series(1,50) n`)
    await db.query('ANALYZE ci_installation_binding; ANALYZE organization')
    const expected = ['ci_binding_organization_id_idx', 'ci_binding_account_login_idx', 'ci_binding_account_id_idx']
    const [target] = await db.query('SELECT organization_id FROM ci_installation_binding WHERE account_id=25 LIMIT 1')
    const urls = [
      path(target.organization_id),
      '/ci/connections?account_type=User&github_account=account-25',
      '/ci/connections?account_type=User&github_account_id=25',
    ]
    for (let i = 0; i < urls.length; i++) {
      statements.length = 0
      const response = await request(urls[i] + (urls[i].includes('?') ? '&' : '?') + 'limit=2')
      expect(response.status).toBe(200)
      const page = await response.json()
      expect(page.items).toHaveLength(2)
      expect(page.next_cursor).toBe(page.items[1].binding_id)
      const captured = statements.find((s) => s.sql.includes('ORDER BY b.id LIMIT'))!
      expect(captured).toBeDefined()
      const plan = await db.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + captured.sql, captured.parameters)
      expect(JSON.stringify(plan)).toContain(expected[i])
      const next = await (
        await request(urls[i] + (urls[i].includes('?') ? '&' : '?') + 'limit=2&cursor=' + page.next_cursor)
      ).json()
      expect(next.items.map((row: any) => row.binding_id)).not.toContain(page.next_cursor)
    }
    const runner = db.createQueryRunner()
    try {
      const [before] = await runner.query("SELECT 'ci_binding_account_id_idx'::regclass::oid AS id")
      await new AddCiAdminIndexes1794873600001().up(runner)
      expect((await runner.query("SELECT 'ci_binding_account_id_idx'::regclass::oid AS id"))[0]).toEqual(before)
    } finally {
      await runner.release()
    }
  }, 30000)
  it('refuses column rollback while any administrative grant remains, even disabled', async () => {
    const binding = await create()
    await request(path(first, binding.binding_id), 'DELETE', { expected_generation: binding.generation })
    const runner = db.createQueryRunner()
    try {
      await runner.startTransaction()
      await expect(new AddCiAdminAuthority1794873600000().down(runner)).rejects.toThrow(
        'Retire administrator-managed CI authority',
      )
    } finally {
      await runner.rollbackTransaction()
      await runner.release()
    }
  })
  it('retries an interrupted concurrent index build and refuses an unrelated definition', async () => {
    const writer = db.createQueryRunner(),
      builder = db.createQueryRunner()
    try {
      await builder.query('DROP INDEX ci_binding_account_login_idx')
      await writer.startTransaction()
      await writer.query(
        "INSERT INTO ci_installation_binding(id,github_host,app_client_id,installation_id,account_id,account_login,account_type,organization_id,actor_id,follow_installation) VALUES(gen_random_uuid(),'github.com','test-app',10,20,'alice','User',$1,'owner',true)",
        [first],
      )
      const [{ pid }] = await builder.query('SELECT pg_backend_pid() AS pid')
      const building = builder
        .query(
          'CREATE INDEX CONCURRENTLY ci_binding_account_login_idx ON ci_installation_binding (github_host,account_type,lower(account_login),id)',
        )
        .then(
          () => null,
          (error) => error,
        )
      try {
        const deadline = Date.now() + 1500
        while (true) {
          const [activity] = await db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])
          if (activity?.wait_event_type === 'Lock') break
          if (Date.now() > deadline) throw Error('Index builder did not reach its writer boundary')
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        await db.query('SELECT pg_cancel_backend($1)', [pid])
        expect(await building).toMatchObject({ code: '57014' })
      } finally {
        await writer.rollbackTransaction()
      }
      expect(
        (await db.query("SELECT indisvalid FROM pg_index WHERE indexrelid='ci_binding_account_login_idx'::regclass"))[0]
          .indisvalid,
      ).toBe(false)
      await new AddCiAdminIndexes1794873600001().up(builder)
      expect(
        (await db.query("SELECT indisvalid FROM pg_index WHERE indexrelid='ci_binding_account_login_idx'::regclass"))[0]
          .indisvalid,
      ).toBe(true)
      await builder.query('DROP INDEX ci_binding_account_login_idx')
      await builder.query('CREATE INDEX ci_binding_account_login_idx ON ci_installation_binding (account_login)')
      await expect(new AddCiAdminIndexes1794873600001().up(builder)).rejects.toThrow('unexpected definition')
      await builder.query('DROP INDEX ci_binding_account_login_idx')
      await builder.query(
        'CREATE INDEX ci_binding_account_login_idx ON ci_installation_binding USING brin (github_host,account_type,lower(account_login),id)',
      )
      await expect(new AddCiAdminIndexes1794873600001().up(builder)).rejects.toThrow('unexpected definition')
    } finally {
      if (writer.isTransactionActive) await writer.rollbackTransaction()
      await writer.release()
      await builder.release()
    }
  })
})
