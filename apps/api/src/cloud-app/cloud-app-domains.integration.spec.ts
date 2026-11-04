import { randomUUID } from 'node:crypto'
import { DataSource, type EntityManager } from 'typeorm'
import { Domain } from '../box/entities/domain.entity'
import { DomainService } from '../box/services/domain.service'
import { PreviewController } from '../box/controllers/preview.controller'
import { AddDomain1792972800000 } from '../migrations/pre-deploy/1792972800000-add-domain-migration'
import { AddAppDomainEnvironment1793780200000 } from '../migrations/pre-deploy/1793780200000-add-app-domain-environment-migration'
import { CloudAppDomains } from './cloud-app-domains'
import type { AppRow, EnvRow } from './engine/db'

const describeWithDatabase = process.env.DB_HOST ? describe : describe.skip
const ORG = '00000000-0000-4000-8000-000000000001'
const OTHER_ORG = '00000000-0000-4000-8000-000000000002'
const suffix = 'apps.example.test'

describeWithDatabase('Cloud App platform domains (real PostgreSQL)', () => {
  const schema = `app_domains_${process.pid}_${randomUUID().replaceAll('-', '')}`
  const appSchema = `${schema}_engine`
  let source: DataSource
  let database: DataSource
  let domains: DomainService
  let adapter: CloudAppDomains
  let app: AppRow
  let env: EnvRow

  beforeAll(async () => {
    source = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Domain],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    await source.query(`CREATE SCHEMA "${schema}"`)
    await source.query(`CREATE SCHEMA "${appSchema}"`)
    await source.query(`CREATE TABLE "${schema}".organization (id UUID PRIMARY KEY)`)
    const runner = source.createQueryRunner()
    try {
      await new AddDomain1792972800000().up(runner)
      await new AddAppDomainEnvironment1793780200000().up(runner)
    } finally {
      await runner.release()
    }
    await source.query(
      `CREATE TABLE "${appSchema}".apps (id TEXT PRIMARY KEY, org_id UUID NOT NULL, name TEXT NOT NULL, deleted_at TIMESTAMPTZ)`,
    )
    await source.query(
      `CREATE TABLE "${appSchema}".envs (id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES "${appSchema}".apps(id), name TEXT NOT NULL, public_url TEXT)`,
    )
    await source.query(
      `CREATE TABLE "${appSchema}".activity (id BIGSERIAL PRIMARY KEY, app_id TEXT NOT NULL, env TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, detail JSONB, ts TIMESTAMPTZ NOT NULL)`,
    )

    // Only schema names change for test isolation; SQL, transactions, locks and ownership checks run on PostgreSQL.
    const scopedSql = (sql: string) => sql.replaceAll('cloud_app.', `"${appSchema}".`)
    database = {
      query: (sql: string, parameters?: unknown[]) => source.query(scopedSql(sql), parameters),
      transaction: (work: (manager: EntityManager) => Promise<unknown>) =>
        source.transaction((manager) => {
          const scoped = Object.create(manager) as EntityManager
          scoped.query = (sql: string, parameters?: unknown[]) => manager.query(scopedSql(sql), parameters)
          return work(scoped)
        }),
    } as DataSource
    const config = {
      get: (key: string) => (key === 'domain.appDomain' || key === 'domain.appHost' ? suffix : undefined),
      getOrThrow: (key: string) =>
        key === 'domain.platformSubdomainMinLength' ? 5 : key === 'proxy.protocol' ? 'https' : 'proxy.example.test',
    }
    domains = new DomainService(database, { findOne: async () => null } as never, config as never)
    adapter = new CloudAppDomains(domains, database)
  })

  afterAll(async () => {
    if (!source?.isInitialized) return
    try {
      await source.query(`DROP SCHEMA IF EXISTS "${appSchema}" CASCADE`)
      await source.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await source.destroy()
    }
  })

  beforeEach(async () => {
    await source.query(
      `TRUNCATE "${schema}".domain, "${schema}".organization, "${appSchema}".activity, "${appSchema}".envs, "${appSchema}".apps`,
    )
    await source.query(`INSERT INTO "${schema}".organization (id, domain_count_limit) VALUES ($1, 5), ($2, 5)`, [
      ORG,
      OTHER_ORG,
    ])
    ;[app] = await database.query('INSERT INTO cloud_app.apps (id, org_id, name) VALUES ($1, $2, $3) RETURNING *', [
      'app_a',
      ORG,
      'demo',
    ])
    await database.query('INSERT INTO cloud_app.apps (id, org_id, name) VALUES ($1, $2, $3)', [
      'app_b',
      OTHER_ORG,
      'demo',
    ])
    ;[env] = await database.query('INSERT INTO cloud_app.envs (id, app_id, name) VALUES ($1, $2, $3) RETURNING *', [
      'env_a_main',
      app.id,
      'main',
    ])
    await database.query('INSERT INTO cloud_app.envs (id, app_id, name) VALUES ($1, $2, $3), ($4, $5, $6)', [
      'env_a_stage',
      app.id,
      'staging',
      'env_b_main',
      'app_b',
      'main',
    ])
  })

  function preview() {
    return new PreviewController(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      domains,
    )
  }

  it('allocates one stable default hostname through the platform quota and persists its App environment target', async () => {
    const url = await adapter.ensureEnvironment(app, env)
    expect(url).toBe(`https://app-envamain.${suffix}`)
    const [stored] = await database.query('SELECT public_url FROM cloud_app.envs WHERE id = $1', [env.id])
    expect(stored.public_url).toBe(url)
    await expect(domains.resolve(new URL(url).hostname)).resolves.toEqual({
      type: 'app',
      app: app.id,
      environment: env.id,
    })
    await expect(preview().resolveDomain(new URL(url).hostname)).resolves.toEqual({
      type: 'app',
      environmentId: env.id,
    })
    await expect(adapter.ensureEnvironment(app, { ...env })).resolves.toBe(url)
    expect((await domains.listHeld(ORG)).used).toBe(1)
    await expect(adapter.list(app, env)).resolves.toEqual([])
  })

  it('binds an owned platform alias immediately and keeps ownership when it is removed', async () => {
    await adapter.ensureEnvironment(app, env)
    const held = await domains.claim(ORG, 'friendly')
    await expect(adapter.add(app, env, held.hostname, 'user')).resolves.toMatchObject({
      host: held.hostname,
      status: 'active',
      records: [],
    })
    await expect(adapter.verifiedHost(env, `${held.hostname}:443`)).resolves.toBe(held.hostname)
    expect(await adapter.list(app, env)).toHaveLength(1)
    await adapter.remove(app, env, held.hostname, 'user')
    await expect(adapter.verifiedHost(env, held.hostname)).resolves.toBeNull()
    expect((await domains.listHeld(ORG)).used).toBe(2)
    await expect(domains.owned(ORG, held.hostname)).resolves.toMatchObject({ target: null })
    const activity = await database.query('SELECT action FROM cloud_app.activity ORDER BY id')
    expect(activity.map((row: { action: string }) => row.action)).toEqual(['domain.add', 'domain.remove'])
  })

  it('enforces organization, App and environment ownership at binding', async () => {
    const held = await domains.claim(ORG, 'private')
    await expect(domains.bindApp(OTHER_ORG, app.id, env.id, held.hostname)).rejects.toMatchObject({ status: 404 })
    await expect(domains.bindApp(ORG, app.id, 'env_b_main', held.hostname)).rejects.toMatchObject({ status: 404 })
    const foreign = await domains.claim(OTHER_ORG, 'foreign')
    await expect(domains.bindApp(ORG, app.id, env.id, foreign.hostname)).rejects.toMatchObject({ status: 404 })
    await expect(domains.owned(ORG, held.hostname)).resolves.toMatchObject({ target: null })
    await expect(domains.owned(OTHER_ORG, foreign.hostname)).resolves.toMatchObject({ target: null })
  })

  it('does not let the App alias endpoint move another environment’s binding', async () => {
    const held = await domains.claim(ORG, 'staging')
    await domains.bindApp(ORG, app.id, 'env_a_stage', held.hostname)
    await expect(adapter.add(app, env, held.hostname, 'app-key')).rejects.toMatchObject({ status: 409 })
    await expect(adapter.remove(app, env, held.hostname, 'app-key')).rejects.toMatchObject({ status: 404 })
    await expect(adapter.verifiedHost(env, held.hostname)).resolves.toBeNull()
    await expect(domains.resolve(held.hostname)).resolves.toMatchObject({ type: 'app', environment: 'env_a_stage' })
  })

  it('serializes default hostname admission against the existing organization domain limit', async () => {
    await source.query(`UPDATE "${schema}".organization SET domain_count_limit = 1 WHERE id = $1`, [ORG])
    const [staging] = await database.query('SELECT * FROM cloud_app.envs WHERE id = $1', ['env_a_stage'])
    const results = await Promise.allSettled([
      adapter.ensureEnvironment(app, env),
      adapter.ensureEnvironment(app, staging),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await domains.listHeld(ORG)).used).toBe(1)
    const exposed = await database.query('SELECT id FROM cloud_app.envs WHERE public_url IS NOT NULL')
    expect(exposed).toHaveLength(1)
  })

  it('releases only an environment’s generated default name and retains aliases as unbound organization names', async () => {
    await adapter.ensureEnvironment(app, env)
    const [staging] = await database.query('SELECT * FROM cloud_app.envs WHERE id = $1', ['env_a_stage'])
    const stageUrl = await adapter.ensureEnvironment(app, staging)
    const alias = await domains.claim(ORG, 'stage-alias')
    await adapter.add(app, staging, alias.hostname, 'user')
    await adapter.releaseEnvironment(app, staging)
    await adapter.releaseEnvironment(app, staging)
    await expect(domains.resolve(new URL(stageUrl).hostname)).resolves.toBeNull()
    await expect(domains.owned(ORG, alias.hostname)).resolves.toMatchObject({ target: null })
    await expect(domains.resolve(new URL(env.public_url!).hostname)).resolves.toMatchObject({
      type: 'app',
      environment: env.id,
    })
    expect((await domains.listHeld(ORG)).used).toBe(2)
  })

  it('refuses BYOD and removal of the default URL and stops routing a deleted App', async () => {
    const url = await adapter.ensureEnvironment(app, env)
    await expect(adapter.add(app, env, 'customer.example.net', 'user')).rejects.toMatchObject({ status: 400 })
    await expect(adapter.remove(app, env, new URL(url).hostname, 'user')).rejects.toMatchObject({ status: 400 })
    await expect(domains.unbind(ORG, new URL(url).hostname)).rejects.toMatchObject({
      status: 400,
      response: { code: 'app_domain_managed' },
    })
    await expect(domains.bindApp(ORG, app.id, 'staging', new URL(url).hostname)).rejects.toMatchObject({
      status: 400,
      response: { code: 'app_domain_managed' },
    })
    await expect(domains.bindApp(ORG, app.id, env.id, new URL(url).hostname)).resolves.toMatchObject({
      target: { environment: env.id },
    })
    await database.query('UPDATE cloud_app.apps SET deleted_at = now() WHERE id = $1', [app.id])
    await expect(preview().resolveDomain(new URL(url).hostname)).rejects.toMatchObject({ status: 404 })
    expect((await domains.listHeld(ORG)).used).toBe(1)
  })
})
