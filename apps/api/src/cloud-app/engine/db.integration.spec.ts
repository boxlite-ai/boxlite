import { randomUUID } from 'node:crypto'
import { DataSource, type QueryRunner } from 'typeorm'
import { AddCloudAppPlatform1793780100000 } from '../../migrations/pre-deploy/1793780100000-add-cloud-app-platform-migration'
import { EncryptionService } from '../../encryption/encryption.service'
import { Store, type Deployment, now } from './db'
import { AddAppBoxOwnership1794500000000 } from '../../migrations/pre-deploy/1794500000000-add-app-box-ownership-migration'
import { TrackLegacyBuildSource1795507200000 } from '../../migrations/pre-deploy/1795507200000-track-legacy-build-source-migration'
import { DropAppBoxPointer1794500001000 } from '../../migrations/post-deploy/1794500001000-drop-app-box-pointer-migration'
import Redis from 'ioredis'
import { RedisLockProvider } from '../../box/common/redis-lock.provider'
import { CloudAppService } from '../cloud-app.service'
import { DomainCountLimitReachedError } from '../../box/errors/domain.error'
import { sha256hex } from './auth'
import type { Ctx } from './ctx'
import { HttpError } from './errors'
import { SupervisorLink } from './orchestrator/supervisor-link'
import { Resources } from './resources'
import { svRoutes } from './routes/sv'
import type { Spec } from './spec'

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
      extra: { options: `-c search_path=${schema},public` },
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
      await new TrackLegacyBuildSource1795507200000().up({
        query: (sql: string) => runner.query(sql.replaceAll('cloud_app.', `${schema}.`)),
      } as QueryRunner)
      await runner.query(`ALTER TABLE ${schema}.box ADD COLUMN env jsonb, ADD COLUMN "desiredState" text`)
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

  function supervisorRoutes() {
    const ctx = {
      store: a,
      config: { supervisorUrl: 'https://supervisor.example.test' },
      origins: { envUrl: async () => 'https://app.example.test' },
      bus: { publish: jest.fn() },
    } as unknown as Ctx
    ctx.resources = new Resources(ctx)
    const link = new SupervisorLink(ctx)
    ctx.orchestrator = { onSupervisorStatus: link.report.bind(link) } as unknown as Ctx['orchestrator']
    const routes = svRoutes(ctx)
    routes.onError((err, c) => {
      if (err instanceof HttpError) return c.json(err.toBody(), err.status as 400)
      throw err
    })
    return routes
  }

  test('recovery binds both projections to the active Box and its committed Spec', async () => {
    const appId = 'app_recovery'
    const envId = `env_${appId}`
    await app(a, appId)
    const source = await a.insertDeployment(
      { ...deployment(), status: 'superseded', spec_version: 1, snapshot_id: 'source', release: 1 },
      envId,
    )
    const live = await a.insertDeployment(
      { ...deployment(), kind: 'apply', status: 'live', spec_version: 2, release: source.number },
      envId,
    )
    const sourceSpec = {
      version: 1,
      deployment: source.number,
      variables: { THEME: 'light' },
      runtime: { image: 'node', size: 'small' },
      volumes: [],
    } as unknown as Spec
    await a.insertSpec(envId, sourceSpec)
    await a.insertSpec(envId, { ...sourceSpec, version: 2, deployment: live.number, variables: { THEME: 'dark' } })
    await a.updateEnv(envId, {
      active_box_id: 'recovery-box',
      box_image: 'node',
      box_size: 'small',
      live_deployment: live.number,
      requested_deployment: live.number,
    })
    const provisioned = 'synthetic-provisioned-token'
    const replacement = 'synthetic-replacement-token'
    await dataSource.query(
      `INSERT INTO ${schema}.box (id, "organizationId", app_id, environment_id, env, "desiredState")
       VALUES ($1, $2, $3, $4, $5, 'started')`,
      ['recovery-box', orgA, appId, envId, { BOXLITE_BOX_TOKEN: provisioned }],
    )
    for (const token of [provisioned, replacement]) {
      await a.run('INSERT INTO box_tokens (hash, env_id, created_at) VALUES (?, ?, ?)', sha256hex(token), envId, now())
    }
    const routes = supervisorRoutes()
    for (const [phase, theme] of [
      ['build', 'light'],
      ['runtime', 'dark'],
    ]) {
      const request = (token: string) =>
        routes.request(`/v1/spec?phase=${phase}&operation=${live.number}&version=2&box=recovery-box`, {
          headers: { authorization: `Bearer ${token}` },
        })
      expect((await request(replacement)).status).toBe(409)
      const response = await request(provisioned)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ phase, deployment: source.number, env: { THEME: theme } })
    }
  })

  test.each(['/sv/v1/spec', '/api/internal/apps/sv/v1/spec'])(
    'a legacy publish holds source authorization until the cached wake reports its Spec conflict (%s)',
    async (specPath) => {
      const appId = 'app_legacy'
      const envId = `env_${appId}`
      await app(a, appId)
      const live = await a.insertDeployment({ ...deployment(), status: 'live', spec_version: 1 }, envId)
      const next = await a.insertDeployment(
        { ...deployment(), status: 'building', spec_version: 2, snapshot_id: 'snap', box_id: 'legacy-box' },
        envId,
      )
      await a.insertSpec(envId, { version: 1, deployment: live.number } as Spec)
      await a.insertSpec(envId, { version: 2, deployment: next.number } as Spec)
      await a.run(
        "INSERT INTO snapshots (app_id, id, manifest, files, bytes, created_at) VALUES (?, 'snap', '[]', 0, 0, ?)",
        appId,
        now(),
      )
      await a.updateEnv(envId, {
        active_box_id: 'legacy-box',
        live_deployment: live.number,
        requested_deployment: next.number,
      })
      await a.updateDeployment(envId, next.number, { legacy_source: 'authorized' })
      const token = 'synthetic-legacy-token'
      await a.run('INSERT INTO box_tokens (hash, env_id, created_at) VALUES (?, ?, ?)', sha256hex(token), envId, now())
      const routes = supervisorRoutes()
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      const request = (path: string) => routes.request(path, { headers })
      const report = (status: object) =>
        routes.request('/v1/status', {
          method: 'POST',
          headers,
          body: JSON.stringify({ deployment: next.number, ...status }),
        })

      const projection = await request('/v1/spec')
      expect(projection.status).toBe(200)
      const snapshotUrl = new URL((await projection.json()).snapshot.url)
      const snapshotPath = snapshotUrl.pathname.replace('/sv/', '/') + snapshotUrl.search
      const download = await request(snapshotPath)
      expect(download.status).toBe(200)
      expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0)
      expect((await a.deployment(envId, next.number))?.legacy_source).toBe('read')
      const early = await request('/v1/spec')
      expect(early.status).toBe(409)

      expect((await report({ phase: 'built' })).status).toBe(200)
      await a.updateEnv(envId, { requested_deployment: live.number })
      expect((await request('/v1/spec')).status).toBe(409)
      expect((await request(snapshotPath)).status).toBe(409)
      expect(
        (await report({ phase: 'failed', step: 'spec', error: `GET ${specPath}: HTTP 409: ${await early.text()}` }))
          .status,
      ).toBe(200)
      expect((await a.deployment(envId, next.number))?.legacy_source).toBe('ended')
      expect(
        await a.get('SELECT status FROM supervisor_status WHERE env_id = ? AND release = ?', envId, next.number),
      ).toMatchObject({ status: { phase: 'built' } })
      const settled = await request('/v1/spec')
      expect(settled.status).toBe(200)
      expect(await settled.json()).toMatchObject({ deployment: null, snapshot: null })

      const conflict = `GET ${specPath}: HTTP 409: {"error":{"code":"conflict"}}`
      expect((await report({ phase: 'failed', step: 'spec', error: conflict })).status).toBe(200)
      expect(
        await a.get('SELECT status FROM supervisor_status WHERE env_id = ? AND release = ?', envId, next.number),
      ).toMatchObject({ status: { phase: 'failed', error: conflict } })
    },
  )

  test('a cached wake cannot complete or overwrite an apply activation for the same release', async () => {
    const envId = 'env_app_activation'
    await app(a, 'app_activation')
    const release = await a.insertDeployment({ ...deployment(), status: 'live' }, envId)
    const apply = await a.insertDeployment(
      { ...deployment(), kind: 'apply', status: 'starting', spec_version: 2, release: release.number },
      envId,
    )
    await a.updateEnv(envId, { live_deployment: release.number, requested_deployment: apply.number })
    const env = (await a.envById(envId))!
    const publish = jest.fn()
    const link = new SupervisorLink({ store: a, bus: { publish }, timing: { activateMs: 1000 } } as unknown as Ctx)
    const cachedWake = { deployment: release.number, phase: 'live' } as const
    const activation = { operation: apply.number, spec_version: 2 }
    await link.report(env, cachedWake)
    await link.report(env, { ...cachedWake, ...activation, spec_version: 1 })
    expect(publish).not.toHaveBeenCalled()
    const matching = { ...cachedWake, ...activation }
    await link.report(env, matching)
    await link.report(env, cachedWake)
    expect(publish).toHaveBeenCalledTimes(1)
    await expect(link.waitLive(envId, release.number, undefined, activation)).resolves.toEqual(matching)
  })

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
  let redis: Redis
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
    await dataSource.query(`INSERT INTO ${routeSchema}.organization VALUES ($1),($2)`, [orgA, orgB])
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
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD,
      lazyConnect: true,
    })
    await redis.connect()
    const lifecycle = Object.assign(Object.create(CloudAppService.prototype), {
      locks: new RedisLockProvider(redis),
    }) as CloudAppService
    const { buildCtx, createServer } = await import('./server')
    const { ensureSqlParser } = await import('./sqlguard')
    await ensureSqlParser()
    context = buildCtx(
      {
        publicUrl: 'https://api.example.test/api/internal/apps',
        supervisorUrl: 'https://guest-api.example.test/api/internal/apps',
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
          hasScanned: async () => false,
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
        withPurgeLock: (appId, operation) => lifecycle.withPurgeLock(appId, operation),
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
      redis?.disconnect()
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
    expect(releaseDomain).toHaveBeenCalledWith(
      expect.objectContaining({ id: app.id, org_id: app.org_id }),
      expect.objectContaining({ app_id: app.id }),
    )
    expect(await store.appById(app.id)).toBeUndefined()
    expect(await store.get('SELECT 1 FROM app_secrets WHERE app_id = ?', app.id)).toBeUndefined()
    jest.restoreAllMocks()
  })

  test('cannot restore after purge cleanup has started and a resource deletion fails', async () => {
    const created = await request('/v1/apps', 'POST', { name: 'purge-failure' })
    expect(created.status).toBe(201)
    const app = (await store.appByName('purge-failure'))!
    await store.run(
      'UPDATE apps SET deleted_at = ?, purge_after = ? WHERE id = ?',
      now(),
      new Date(Date.now() + 86_400_000).toISOString(),
      app.id,
    )
    const source = jest.spyOn(context.blobs, 'deleteApp').mockRejectedValue(new Error('object storage unavailable'))
    try {
      const { purgeApp, restoreApp } = await import('./lifecycle')
      await expect(purgeApp(context, (await store.appById(app.id))!)).rejects.toThrow('object storage unavailable')
      await expect(restoreApp(context, (await store.appById(app.id))!, 'user')).rejects.toMatchObject({ status: 409 })
      expect((await store.appById(app.id))?.deleted_at).toBeTruthy()
      source.mockResolvedValue(undefined)
      const { purgeExpired } = await import('./lifecycle')
      expect(await purgeExpired(context)).toContain(app.name)
      expect(source).toHaveBeenCalledTimes(2)
      expect(await store.appById(app.id)).toBeUndefined()
    } finally {
      source.mockRestore()
    }
  })

  test('permanent deletion accepts only retained Apps in the current organization', async () => {
    expect((await request('/v1/apps', 'POST', { name: 'retained-app' })).status).toBe(201)
    const app = (await store.appByName('retained-app'))!
    expect((await request('/v1/apps/deleted/retained-app', 'DELETE')).status).toBe(404)
    expect((await request('/v1/apps/deleted/missing-app', 'DELETE')).status).toBe(404)
    expect(await store.appById(app.id)).toBeDefined()
    const foreign = new Store(dataSource, orgB, undefined, routeSchema)
    await foreign.run(
      'INSERT INTO apps (id,name,created_at,deleted_at,purge_after,org_id) VALUES (?,?,?,?,?,?)',
      'foreign-retained',
      'foreign-retained',
      now(),
      now(),
      new Date(Date.now() + 86_400_000).toISOString(),
      orgB,
    )
    expect((await request('/v1/apps/deleted/foreign-retained', 'DELETE')).status).toBe(404)
    expect(await foreign.appById('foreign-retained')).toBeDefined()
    expect((await request('/v1/apps/retained-app', 'DELETE')).status).toBe(204)
    expect((await request('/v1/apps/deleted/retained-app/restore', 'POST')).status).toBe(200)
    expect((await request('/v1/apps/retained-app', 'DELETE')).status).toBe(204)
    const denied = await server.request(
      '/v1/apps/%64eleted/retained-app',
      { method: 'DELETE' },
      { platformPrincipal: { ...principal, permissions: ['write:apps'] } },
    )
    expect(denied.status).toBe(403)
    expect(await store.appById(app.id)).toBeDefined()
    expect((await request('/v1/apps/deleted/retained-app', 'DELETE')).status).toBe(204)
    expect(await store.appById(app.id)).toBeUndefined()
    expect((await request('/v1/apps/deleted/retained-app', 'DELETE')).status).toBe(404)
  })

  test('cleanup rejects concurrent restore and purge without holding a SQL transaction', async () => {
    expect((await request('/v1/apps', 'POST', { name: 'purge-concurrent' })).status).toBe(201)
    const active = (await store.appByName('purge-concurrent'))!
    expect((await request('/v1/apps/purge-concurrent', 'DELETE')).status).toBe(204)
    let started!: () => void
    let release!: () => void
    const cleaning = new Promise<void>((resolve) => (started = resolve))
    const finish = new Promise<void>((resolve) => (release = resolve))
    const source = jest.spyOn(context.blobs, 'deleteApp').mockImplementation(async () => {
      started()
      await finish
    })
    const boxes = jest.spyOn(context.boxes, 'list')
    const purging = request('/v1/apps/deleted/purge-concurrent', 'DELETE')
    try {
      await cleaning
      expect((await request('/v1/apps/deleted/purge-concurrent/restore', 'POST')).status).toBe(409)
      expect((await request('/v1/apps/deleted/purge-concurrent', 'DELETE')).status).toBe(409)
      const { deleteApp, purgeExpired } = await import('./lifecycle')
      const repeated = await deleteApp(context, active, 'late-soft-delete')
      expect(new Date(repeated.purge_after).getTime()).toBeLessThanOrEqual(Date.now())
      expect(boxes).toHaveBeenCalledTimes(1)
      const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      try {
        expect(await purgeExpired(context)).not.toContain(active.name)
      } finally {
        errors.mockRestore()
      }
      expect(source).toHaveBeenCalledTimes(1)
      // Remote cleanup has no open SQL transaction or row lock.
      const other = new Store(dataSource, orgA, undefined, routeSchema)
      await other.tx(async () => {
        expect(await other.get('SELECT id FROM apps WHERE id = ? FOR UPDATE NOWAIT', active.id)).toBeDefined()
      })
    } finally {
      release()
      const response = await purging
      source.mockRestore()
      boxes.mockRestore()
      expect(response.status).toBe(204)
    }
    expect(await store.appById(active.id)).toBeUndefined()
  })

  test('a periodic purge rechecks a candidate restored after its scan', async () => {
    expect((await request('/v1/apps', 'POST', { name: 'restored-after-scan' })).status).toBe(201)
    expect((await request('/v1/apps/restored-after-scan', 'DELETE')).status).toBe(204)
    const app = (await store.appByNameAnyState('restored-after-scan'))!
    const { purgeExpired, restoreApp } = await import('./lifecycle')
    const all = store.all.bind(store)
    const scan = jest.spyOn(store, 'all').mockImplementation(async (sql, ...params) => {
      const rows = await all(sql, ...params)
      if (sql.startsWith('SELECT * FROM apps WHERE deleted_at IS NOT NULL')) await restoreApp(context, app, 'user')
      return rows
    })
    const cleanup = jest.spyOn(context.blobs, 'deleteApp')
    try {
      expect(await purgeExpired(context, new Date(Date.now() + 8 * 86_400_000))).not.toContain(app.name)
      expect((await store.appById(app.id))?.deleted_at).toBeNull()
      expect(cleanup).not.toHaveBeenCalledWith(app.id)
    } finally {
      scan.mockRestore()
      cleanup.mockRestore()
    }
  })

  test('the retention deadline rejects restore before the periodic purge runs', async () => {
    expect((await request('/v1/apps', 'POST', { name: 'retention-ended' })).status).toBe(201)
    expect((await request('/v1/apps/retention-ended', 'DELETE')).status).toBe(204)
    const app = (await store.appByNameAnyState('retention-ended'))!
    await store.run('UPDATE apps SET purge_after = clock_timestamp() WHERE id = ?', app.id)
    expect((await request('/v1/apps/deleted/retention-ended/restore', 'POST')).status).toBe(409)
  })

  test('reads App projections at full domain quota without allocating missing URLs', async () => {
    const { createApp } = await import('./services/apps')
    const assigned = await createApp(context, 'domain-assigned', 'test')
    const unassigned = await createApp(context, 'domain-unassigned', 'test')
    const main = (await store.envByName(assigned.id, 'main'))!
    const draft = (await store.envByName(unassigned.id, 'main'))!
    const url = 'https://already-assigned.apps.example.test'
    await store.updateEnv(main.id, { public_url: url })
    expect((await request('/v1/apps/domain-assigned/environments', 'POST', { name: 'staging' })).status).toBe(201)
    const allocate = jest.fn(async () => {
      throw new DomainCountLimitReachedError(1, 1)
    })
    const origin = jest.spyOn(context.origins, 'envUrl').mockImplementation(async (env) => {
      if (env.public_url) return env.public_url
      return allocate()
    })
    try {
      const listing = await request('/v1/apps')
      expect(listing.status).toBe(200)
      expect(await listing.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: assigned.name, url: `${url}/` }),
          expect.objectContaining({ name: unassigned.name, url: null }),
        ]),
      )
      const assignedDetail = await request(`/v1/apps/${assigned.name}/view`)
      expect(assignedDetail.status).toBe(200)
      expect(await assignedDetail.json()).toMatchObject({
        url: `${url}/`,
        auth: { loginUrl: `${url}/.boxlite/auth/login` },
      })
      const unassignedDetail = await request(`/v1/apps/${unassigned.name}/view`)
      expect(unassignedDetail.status).toBe(200)
      expect(await unassignedDetail.json()).toMatchObject({ url: null, auth: { loginUrl: null } })
      const environments = await request(`/v1/apps/${assigned.name}/environments`)
      expect(environments.status).toBe(200)
      expect(await environments.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'main', url: `${url}/` }),
          expect.objectContaining({ name: 'staging', url: null }),
        ]),
      )
      expect(allocate).not.toHaveBeenCalled()
      expect(await context.resources.runtimeEnv(assigned, (await store.envById(main.id))!, undefined)).toMatchObject({
        BOXLITE_APP_URL: url,
      })
      await expect(context.resources.runtimeEnv(unassigned, draft, undefined)).rejects.toBeInstanceOf(
        DomainCountLimitReachedError,
      )
      expect(allocate).toHaveBeenCalledTimes(1)
    } finally {
      origin.mockRestore()
    }
  })
})
