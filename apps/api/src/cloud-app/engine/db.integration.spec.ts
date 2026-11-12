import { randomUUID } from 'node:crypto'
import { DataSource, type QueryRunner } from 'typeorm'
import { AddCloudAppPlatform1793780100000 } from '../../migrations/pre-deploy/1793780100000-add-cloud-app-platform-migration'
import { EncryptionService } from '../../encryption/encryption.service'
import { Store, type Deployment, now } from './db'
import { AddAppBoxOwnership1794500000000 } from '../../migrations/pre-deploy/1794500000000-add-app-box-ownership-migration'
import { DropAppBoxPointer1794500001000 } from '../../migrations/post-deploy/1794500001000-drop-app-box-pointer-migration'

async function migrateBoxOwnership(runner: QueryRunner, schema: string) {
  await runner.query(`CREATE TABLE ${schema}.box (id text PRIMARY KEY, "organizationId" uuid)`)
  const scoped = {
    query: (sql: string) =>
      runner.query(sql.replaceAll('cloud_app.', `${schema}.`).replace(/\bbox\b/g, `${schema}.box`)),
  } as QueryRunner
  await new AddAppBoxOwnership1794500000000().up(scoped)
  await new DropAppBoxPointer1794500001000().up(scoped)
}

const describeDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `cloud_app_${randomUUID().replaceAll('-', '')}`
const orgA = randomUUID()
const orgB = randomUUID()
jest.setTimeout(30000)

describeDatabase('Cloud App PostgreSQL repository', () => {
  let dataSource: DataSource
  let a: Store
  let b: Store
  let encryption: EncryptionService

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
    }).initialize()
    await dataSource.query(`CREATE SCHEMA ${schema}`)
    await dataSource.query(`CREATE TABLE ${schema}.organization (id UUID PRIMARY KEY)`)
    await dataSource.query(`INSERT INTO ${schema}.organization VALUES ($1),($2)`, [orgA, orgB])
    const runner = dataSource.createQueryRunner()
    try {
      await new AddCloudAppPlatform1793780100000().up({
        query: (sql: string) =>
          runner.query(
            sql
              .replace('CREATE SCHEMA cloud_app;', '')
              .replaceAll('cloud_app.', `${schema}.`)
              .replaceAll('public.organization', `${schema}.organization`),
          ),
      } as never)
      await migrateBoxOwnership(runner, schema)
    } finally {
      await runner.release()
    }
    encryption = new EncryptionService({ getOrThrow: () => randomUUID() } as never)
    a = new Store(dataSource, orgA, encryption, schema)
    b = new Store(dataSource, orgB, encryption, schema)
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      await dataSource.query(`DROP SCHEMA ${schema} CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE ${schema}.apps CASCADE`)
  })

  async function app(store: Store, id: string) {
    await store.run(
      'INSERT INTO apps (id,name,created_at,org_id) VALUES (?,?,?,?)',
      id,
      'same-name',
      now(),
      store.organizationId,
    )
    await store.run(
      'INSERT INTO envs (id,app_id,name,created_at,forward_secret,control_secret) VALUES (?,?,?,?,?,?)',
      `env_${id}`,
      id,
      'main',
      now(),
      'forward-test-value',
      'control-test-value',
    )
  }

  test('same names resolve only in the selected organization', async () => {
    await app(a, 'app_a')
    await app(b, 'app_b')
    expect((await a.appByName('same-name'))?.id).toBe('app_a')
    expect((await b.appByName('same-name'))?.id).toBe('app_b')
    expect(await a.appById('app_b')).toBeUndefined()
    expect((await a.apps()).map((row) => row.id)).toEqual(['app_a'])
  })

  test('nested asynchronous repository work rolls back together', async () => {
    await expect(
      a.tx(async () => {
        await app(a, 'app_rollback')
        await a.tx(async () => {
          await a.updateApp('app_rollback', { neon_project_id: 'project-test' })
        })
        throw new Error('abort transaction')
      }),
    ).rejects.toThrow('abort transaction')
    expect(await a.appById('app_rollback')).toBeUndefined()
  })

  test('environment credentials are encrypted in Postgres and resolved on read', async () => {
    await app(a, 'app_secret')
    const [stored] = await dataSource.query(`SELECT forward_secret,control_secret FROM ${schema}.envs WHERE id=$1`, [
      'env_app_secret',
    ])
    expect(stored.forward_secret).not.toContain('forward-test-value')
    expect(stored.control_secret).not.toContain('control-test-value')
    expect((await a.envById('env_app_secret'))?.control_secret).toBe('control-test-value')
    await a.updateEnv('env_app_secret', { db_url: 'postgresql://test-user:test-password@example.test/db' })
    const [changed] = await dataSource.query(`SELECT db_url FROM ${schema}.envs WHERE id=$1`, ['env_app_secret'])
    expect(changed.db_url).not.toContain('test-password')
    expect((await a.envById('env_app_secret'))?.db_url).toContain('test-password')
  })

  function deployment(key: string | null = null): Omit<Deployment, 'number' | 'env_id'> {
    return {
      kind: 'deploy',
      status: 'queued',
      message: null,
      by: 'test',
      created_at: now(),
      started_at: null,
      finished_at: null,
      spec_version: null,
      base_version: 0,
      snapshot_id: null,
      steps: [],
      changes: [],
      error: null,
      request: { kind: 'deploy' },
      idempotency_key: key,
      release: null,
      box_id: null,
      built: false,
      restore_point: null,
      live_at: null,
    }
  }

  test('concurrent deployments allocate distinct numbers and idempotent replays reuse a row', async () => {
    await app(a, 'app_queue')
    const rows = await Promise.all(Array.from({ length: 8 }, () => a.insertDeployment(deployment(), 'env_app_queue')))
    expect(rows.map((row) => row.number).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    const replay = await Promise.all([
      a.insertDeployment(deployment('request-1'), 'env_app_queue'),
      a.insertDeployment(deployment('request-1'), 'env_app_queue'),
    ])
    expect(replay[0].number).toBe(replay[1].number)
    const events = await Promise.all(
      Array.from({ length: 6 }, () => a.insertEvent('env_app_queue', 1, 'step', { status: 'running' })),
    )
    expect(events.sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('concurrent environments share one Neon project across repository instances', async () => {
    await app(a, 'app_parallel')
    await a.run(
      'INSERT INTO envs (id,app_id,name,created_at,forward_secret,control_secret) VALUES (?,?,?,?,?,?)',
      'env_staging',
      'app_parallel',
      'staging',
      now(),
      'forward-staging',
      'control-staging',
    )
    const createProject = jest.fn(async () => ({
      projectId: randomUUID(),
      mainBranchId: 'branch-main',
      connectionUri: 'postgresql://owner:password@database.example.test/neondb',
    }))
    const neon = {
      createProject,
      createBranch: async () => ({ branchId: 'branch-staging' }),
      connectionUri: async () => 'postgresql://owner:password@database.example.test/neondb',
    }
    const appdb = { ensureReader: async () => undefined, copyMigrationLedger: async () => 0 }
    const { DatabaseProvisioner } = await import('./resources/database')
    const left = new DatabaseProvisioner({ store: a, neon, appdb } as never)
    const right = new DatabaseProvisioner({
      store: new Store(dataSource, orgA, encryption, schema),
      neon,
      appdb,
    } as never)
    await Promise.all([
      left.ensureDatabase('app_parallel', 'env_app_parallel'),
      right.ensureDatabase('app_parallel', 'env_staging'),
    ])
    expect(createProject).toHaveBeenCalledTimes(1)
    expect((await a.appById('app_parallel'))?.neon_project_id).toBe(
      (await createProject.mock.results[0].value).projectId,
    )
    expect((await a.envById('env_staging'))?.neon_branch_id).toBe('branch-staging')
  })
})

describeDatabase('Cloud App management routes with PostgreSQL', () => {
  let dataSource: DataSource
  let store: Store
  let server: ReturnType<typeof import('./server').createServer>
  let context: import('./ctx').Ctx
  const routeSchema = `${schema}_routes`
  const principal = {
    organizationId: orgA,
    userId: 'platform-user',
    actor: 'user:platform-user',
    permissions: ['read:apps', 'write:apps', 'delete:apps'],
  }

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
    }).initialize()
    await dataSource.query(`CREATE SCHEMA ${routeSchema}`)
    await dataSource.query(`CREATE TABLE ${routeSchema}.organization (id UUID PRIMARY KEY)`)
    await dataSource.query(`INSERT INTO ${routeSchema}.organization VALUES ($1)`, [orgA])
    const runner = dataSource.createQueryRunner()
    try {
      await new AddCloudAppPlatform1793780100000().up({
        query: (sql: string) =>
          runner.query(
            sql
              .replace('CREATE SCHEMA cloud_app;', '')
              .replaceAll('cloud_app.', `${routeSchema}.`)
              .replaceAll('public.organization', `${routeSchema}.organization`),
          ),
      } as never)
      await migrateBoxOwnership(runner, routeSchema)
    } finally {
      await runner.release()
    }
    store = new Store(dataSource, orgA, undefined, routeSchema)
    const { buildCtx, createServer } = await import('./server')
    const { ensureSqlParser } = await import('./sqlguard')
    await ensureSqlParser()
    context = buildCtx(
      {
        publicUrl: 'https://api.example.test/api/internal/apps',
        managementUrl: `https://api.example.test/api/v1/${orgA}`,
        artifactUrl: 'https://artifacts.example.test',
        sessionSecret: randomUUID(),
        identityPrivateKey: '',
        runtimeImages: { node: 'node:test' },
        diskSizeGb: 10,
        autoStopSeconds: 900,
        domainsEnabled: true,
        agentMdPath: '/unused/agent.md',
        cliTgzPath: '/unused/boxlite-app.tgz',
        svBinDir: '/unused/sv',
      },
      {
        store,
        credentials: {
          authenticate: async () => null,
        },
        blobs: {
          has: async () => false,
          put: async () => ({ bytes: 0, deduped: false }),
          read: () => {
            throw new Error('source not requested')
          },
          deleteApp: async () => undefined,
        },
        origins: {
          apiUrl: 'https://api.example.test/api/internal/apps',
          consoleUrl: () => `https://console.example.test`,
          envUrl: (env) => `https://${env.id}.apps.example.test`,
        },
        domains: {
          list: async () => [],
          add: async () => {
            throw new Error('unused')
          },
          verify: async () => {
            throw new Error('unused')
          },
          remove: async () => {
            throw new Error('unused')
          },
          verifiedHost: async () => null,
          releaseEnvironment: async () => undefined,
        },
        boxlite: {
          getBox: async () => null,
          createBox: async () => {
            throw new Error('apply has no build')
          },
          deleteBox: async () => undefined,
          startBox: async () => undefined,
          stopBox: async () => undefined,
          tunnel: async () => {
            throw new Error('unused')
          },
        },
        boxes: { list: async () => [] },
        volumes: {
          list: async () => [],
          create: async () => {
            throw new Error('unused')
          },
          remove: async () => undefined,
        },
        neon: {} as never,
        supervisor: {} as never,
        appdb: {} as never,
      },
      { pollMs: 5, buildMs: 1000, activateMs: 1000, supervisorReadyMs: 1000 },
    )
    server = createServer(context)
  })
  afterAll(async () => {
    if (!dataSource?.isInitialized) return
    try {
      await dataSource.query(`DROP SCHEMA ${routeSchema} CASCADE`)
    } finally {
      await dataSource.destroy()
    }
  })

  function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return server.request(
      path,
      {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { platformPrincipal: principal },
    )
  }

  test('create, list, detail, environment and config deployment retain their route contracts', async () => {
    const created = await request('/v1/apps', 'POST', { name: 'route-app' })
    expect(created.status).toBe(201)
    const value = (await created.json()) as { app: { name: string; handoffPrompt: string }; prompt: string }
    expect(value.app.name).toBe('route-app')
    expect(value).not.toHaveProperty('key')
    expect(value.app).not.toHaveProperty('key')
    expect(value.app.handoffPrompt).toBe(value.prompt)
    expect(value.prompt).toContain(`https://api.example.test/api/v1/${orgA}`)
    const list = await request('/v1/apps')
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'route-app' })]))
    const detail = await request('/v1/apps/route-app/view')
    expect(detail.status).toBe(200)
    expect(await detail.json()).toEqual(expect.objectContaining({ name: 'route-app' }))
    const env = await request('/v1/apps/route-app/environments', 'POST', { name: 'staging' })
    expect(env.status).toBe(201)
    const handoff = await request('/v1/apps/route-app/handoff?env=staging')
    expect(handoff.status).toBe(200)
    expect(await handoff.json()).toEqual({
      prompt: expect.stringContaining('boxlite-app init --app route-app --env staging'),
    })
    const removedKeyRoute = await request('/v1/apps/route-app/key/issue', 'POST')
    expect(removedKeyRoute.status).toBe(404)
    const manifest =
      '[app]\nname="route-app"\n[runtime]\nimage="node"\n[[service]]\nname="web"\ncommand="node server.js"\nport=3000\n'
    const plan = await request('/v1/apps/route-app/envs/main/plan', 'POST', {
      manifest,
      base_version: 0,
      migrations: [],
    })
    expect(plan.status).toBe(200)
    expect(((await plan.json()) as { errors: unknown[] }).errors).toEqual([])
    const apply = await request('/v1/apps/route-app/envs/main/deployments', 'POST', {
      kind: 'apply',
      manifest,
      base_version: 0,
      migrations: [],
    })
    expect(apply.status).toBe(202)
    const app = await store.appByName('route-app')
    const main = await store.envByName(app!.id, 'main')
    expect((await store.deployment(main!.id, 1))?.status).toBe('queued')
    await context.orchestrator.runQueued(main!.id)
    expect((await store.deployment(main!.id, 1))?.status).toBe('live')
    expect((await store.spec(main!.id))?.runtime.image).toBe('node')
  })

  test('a callback received by another context wakes a waiter through persisted status', async () => {
    const created = await request('/v1/apps', 'POST', { name: 'callback-app' })
    expect(created.status).toBe(201)
    const app = await store.appByName('callback-app')
    const env = (await store.envByName(app!.id, 'main'))!
    const { sha256hex } = await import('./auth')
    const { SupervisorLink } = await import('./orchestrator/supervisor-link')
    const { buildCtx, createServer } = await import('./server')
    const other = buildCtx(
      context.config,
      { ...context, store: new Store(dataSource, orgA, undefined, routeSchema) },
      { pollMs: 5, buildMs: 1000, activateMs: 1000, supervisorReadyMs: 1000 },
    )
    const token = `test-box-${randomUUID()}`
    await store.run('INSERT INTO box_tokens (hash,env_id,created_at) VALUES (?,?,?)', sha256hex(token), env.id, now())
    const waiting = new SupervisorLink(context).waitPhase(env.id, 1, ['built'], 1000, 'build')
    const response = await createServer(other).request('/sv/v1/status', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deployment: 1, phase: 'built', services: [] }),
    })
    expect(response.status).toBe(200)
    expect((await waiting).phase).toBe('built')
  })

  test('purging removes sources, environment domains and App-owned rows', async () => {
    const created = await request('/v1/apps', 'POST', { name: 'purge-app' })
    expect(created.status).toBe(201)
    const app = (await store.appByName('purge-app'))!
    await store.run(
      'INSERT INTO app_secrets (app_id,name,value,updated_at) VALUES (?,?,?,?)',
      app.id,
      'sample',
      'secret',
      now(),
    )
    const deleteSource = jest.spyOn(context.blobs, 'deleteApp').mockResolvedValue(undefined)
    const releaseDomain = jest.spyOn(context.domains, 'releaseEnvironment').mockResolvedValue(undefined)
    const { purgeApp } = await import('./lifecycle')
    await purgeApp(context, app)
    expect(deleteSource).toHaveBeenCalledWith(app.id)
    expect(releaseDomain).toHaveBeenCalledWith(app, expect.objectContaining({ app_id: app.id }))
    expect(await store.appById(app.id)).toBeUndefined()
    expect(await store.get('SELECT 1 FROM app_secrets WHERE app_id = ?', app.id)).toBeUndefined()
    jest.restoreAllMocks()
  })
})
