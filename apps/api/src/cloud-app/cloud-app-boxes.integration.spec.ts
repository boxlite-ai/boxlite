import { randomUUID } from 'node:crypto'
import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm'
import { Hono } from 'hono'
import { AddCloudAppPlatform1793780100000 } from '../migrations/pre-deploy/1793780100000-add-cloud-app-platform-migration'
import { AddAppBoxOwnership1794500000000 } from '../migrations/pre-deploy/1794500000000-add-app-box-ownership-migration'
import { DropAppBoxPointer1794500001000 } from '../migrations/post-deploy/1794500001000-drop-app-box-pointer-migration'
import { CloudAppResources } from './cloud-app-resources'
import { Store, type AppRow, type EnvRow } from './engine/db'
import { deleteApp, purgeApp } from './engine/lifecycle'
import { envRoutes } from './engine/routes/envs'
import type { Vars } from './engine/auth'
import type { Ctx } from './engine/ctx'

const describeDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `app_boxes_${randomUUID().replaceAll('-', '')}`
const organizationId = randomUUID()
const otherOrganizationId = randomUUID()
const scoped = (sql: string) =>
  sql.replaceAll('cloud_app.', `${schema}.`).replaceAll('public.organization', `${schema}.organization`)
jest.setTimeout(60000)

describeDatabase('Cloud App Box ownership in PostgreSQL', () => {
  let source: DataSource
  let store: Store
  let resources: CloudAppResources
  let app: AppRow
  let main: EnvRow
  const expand = new AddAppBoxOwnership1794500000000()
  const contract = new DropAppBoxPointer1794500001000()

  async function migrate(migration: MigrationInterface, direction: 'up' | 'down' = 'up') {
    const runner = source.createQueryRunner()
    await runner.startTransaction()
    try {
      await migration[direction]({ query: (sql: string) => runner.query(scoped(sql)) } as QueryRunner)
      await runner.commitTransaction()
    } catch (error) {
      await runner.rollbackTransaction()
      throw error
    } finally {
      await runner.release()
    }
  }

  beforeAll(async () => {
    source = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    store = new Store(source, organizationId, undefined, schema)
    resources = new CloudAppResources(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      source,
      {} as never,
    )
  })

  afterAll(async () => {
    if (!source?.isInitialized) return
    try {
      await source.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await source.destroy()
    }
  })

  beforeEach(async () => {
    await source.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};
      CREATE TABLE organization (id uuid PRIMARY KEY);
      CREATE TABLE box (id text PRIMARY KEY, name text, "organizationId" uuid,
        "desiredState" text NOT NULL DEFAULT 'started', "createdAt" timestamptz NOT NULL DEFAULT now());`)
    await source.query('INSERT INTO organization VALUES ($1),($2)', [organizationId, otherOrganizationId])
    await new AddCloudAppPlatform1793780100000().up({
      query: (sql: string) => source.query(scoped(sql.replace('CREATE SCHEMA cloud_app;', ''))),
    } as QueryRunner)
    await store.run(
      'INSERT INTO apps (id,name,created_at,org_id) VALUES (?,?,now(),?),(?,?,now(),?),(?,?,now(),?)',
      'shop',
      'shop',
      organizationId,
      'other',
      'other',
      organizationId,
      'foreign',
      'foreign',
      otherOrganizationId,
    )
    await store.run(`INSERT INTO envs (id,app_id,name,created_at,forward_secret,control_secret,box_id)
      VALUES ('main','shop','main',now(),'forward','control','web'),
      ('stage','shop','staging',now(),'forward','control',NULL),
      ('other-main','other','main',now(),'forward','control',NULL),
      ('foreign-main','foreign','main',now(),'forward','control',NULL)`)
    await source.query(
      `INSERT INTO box (id,name,"organizationId","desiredState") VALUES
      ('web','web',$1,'started'),('old-web','old-web',$1,'destroyed'),
      ('scratch','scratch',$1,'started'),('foreign-box','foreign-box',$2,'started')`,
      [organizationId, otherOrganizationId],
    )
    await store.run(`INSERT INTO deployments (env_id,number,kind,status,by,created_at,request,box_id)
      VALUES ('main',1,'deploy','live','test',now(),'{}','old-web')`)
    app = (await store.appById('shop'))!
    main = (await store.envById('main'))!
  })

  it('backfills current and historical Boxes while leaving standalone Boxes unowned', async () => {
    await migrate(expand)
    expect(await source.query('SELECT id,app_id,environment_id FROM box ORDER BY id')).toEqual([
      { id: 'foreign-box', app_id: null, environment_id: null },
      { id: 'old-web', app_id: 'shop', environment_id: 'main' },
      { id: 'scratch', app_id: null, environment_id: null },
      { id: 'web', app_id: 'shop', environment_id: 'main' },
    ])
    expect((await store.envById('main'))?.active_box_id).toBe('web')
    await expect(source.query("UPDATE box SET app_id='shop' WHERE id='scratch'")).rejects.toThrow('box_app_owner')
  })

  it('lists several Boxes per environment and scopes them to organization and App', async () => {
    await migrate(expand)
    await migrate(contract)
    await source.query(
      `INSERT INTO box (id,name,"organizationId",app_id,environment_id) VALUES
      ('worker','worker',$1,'shop','main'),('stage-web','stage-web',$1,'shop','stage'),
      ('other-box','other-box',$1,'other','other-main'),('foreign-owned','foreign-owned',$2,'foreign','foreign-main')`,
      [organizationId, otherOrganizationId],
    )
    const boxes = resources.boxesForOrganization(organizationId)
    expect((await boxes.list(app)).sort()).toEqual(['stage-web', 'web', 'worker'])
    expect((await boxes.list(app, main)).sort()).toEqual(['web', 'worker'])
    await expect(boxes.list({ ...app, org_id: otherOrganizationId })).rejects.toMatchObject({ status: 404 })
    await expect(boxes.list(app, { ...main, app_id: 'other' })).rejects.toMatchObject({ status: 404 })
  })

  it('synchronizes rolling-deploy writes without detaching the previous active Box', async () => {
    await migrate(expand)
    await source.query(`INSERT INTO box (id,name,"organizationId") VALUES ('replacement','replacement',$1)`, [
      organizationId,
    ])
    await store.run("UPDATE envs SET box_id='replacement' WHERE id='main'")
    expect((await store.envById('main'))?.active_box_id).toBe('replacement')
    expect((await source.query("SELECT app_id,environment_id FROM box WHERE id='replacement'"))[0]).toEqual({
      app_id: app.id,
      environment_id: main.id,
    })
    await store.updateEnv(main.id, { active_box_id: 'web' })
    expect((await store.get<{ box_id: string }>("SELECT box_id FROM envs WHERE id='main'"))?.box_id).toBe('web')
    await store.updateEnv(main.id, { active_box_id: null })
    expect((await resources.boxesForOrganization(organizationId).list(app)).sort()).toEqual(['replacement', 'web'])
    await expect(store.updateEnv(main.id, { active_box_id: 'foreign-box' })).rejects.toThrow('another organization')
    await store.run("UPDATE envs SET box_id='scratch' WHERE id='other-main'")
    await expect(store.updateEnv(main.id, { active_box_id: 'scratch' })).rejects.toThrow('another organization or App')
  })

  it('contracts and reverses the pointer columns without losing the active Box', async () => {
    await migrate(expand)
    await migrate(contract)
    await expect(store.get('SELECT box_id FROM envs')).rejects.toThrow('does not exist')
    await store.updateEnv(main.id, { active_box_id: null })
    expect(await resources.boxesForOrganization(organizationId).list(app)).toEqual(['web'])
    await migrate(contract, 'down')
    await store.updateEnv(main.id, { active_box_id: 'web' })
    expect((await store.get<{ box_id: string }>("SELECT box_id FROM envs WHERE id='main'"))?.box_id).toBe('web')
    await migrate(expand, 'down')
    expect((await store.get<{ box_id: string }>("SELECT box_id FROM envs WHERE id='main'"))?.box_id).toBe('web')
  })

  it('rejects a legacy Box reference from another organization atomically', async () => {
    await source.query('UPDATE box SET "organizationId"=$1 WHERE id=$2', [otherOrganizationId, 'web'])
    await expect(migrate(expand)).rejects.toThrow('another organization')
    const [column] = await source.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema=$1 AND table_name='box' AND column_name='app_id'`,
      [schema],
    )
    expect(column.n).toBe(0)
  })

  it('stops and purges every owned Box, including a non-active worker in the same environment', async () => {
    await migrate(expand)
    await migrate(contract)
    await source.query(
      `INSERT INTO box (id,name,"organizationId",app_id,environment_id)
      VALUES ('worker','worker',$1,'shop','main')`,
      [organizationId],
    )
    const stopped: string[] = []
    const context = {
      store,
      boxes: resources.boxesForOrganization(organizationId),
      resources: {
        sleep: async (id: string) => {
          stopped.push(id)
        },
        deleteVolumes: async () => {
          expect(await resources.boxesForOrganization(organizationId).list(app)).toEqual([])
        },
      },
      boxlite: {
        deleteBox: async (id: string) => {
          await source.query(`UPDATE box SET "desiredState"='destroyed' WHERE id=$1`, [id])
        },
      },
      domains: { releaseEnvironment: async () => undefined },
      blobs: { deleteApp: async () => undefined },
    } as unknown as Ctx
    await deleteApp(context, app, 'owner')
    expect(stopped.sort()).toEqual(['web', 'worker'])
    await purgeApp(context, (await store.appById(app.id))!)
    expect(await store.appById(app.id)).toBeUndefined()
    expect(
      (await source.query(`SELECT id FROM box WHERE "desiredState"='started' ORDER BY id`)).map((row) => row.id),
    ).toEqual(['foreign-box', 'scratch'])
  })

  it('deletes every Box in one environment without touching the other environment', async () => {
    await migrate(expand)
    await migrate(contract)
    await source.query(
      `INSERT INTO box (id,name,"organizationId",app_id,environment_id) VALUES
      ('stage-web','stage-web',$1,'shop','stage'),('stage-worker','stage-worker',$1,'shop','stage')`,
      [organizationId],
    )
    const deleted: string[] = []
    const context = {
      store,
      boxes: resources.boxesForOrganization(organizationId),
      boxlite: {
        deleteBox: async (id: string) => {
          deleted.push(id)
        },
      },
      resources: { deleteVolumes: async () => undefined },
      domains: { releaseEnvironment: async () => undefined },
    } as unknown as Ctx
    const server = new Hono<{ Variables: Vars }>()
    server.use('*', async (c, next) => {
      c.set('app', app)
      await next()
    })
    server.route('/', envRoutes(context))
    const response = await server.request('/envs/staging', { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(deleted.sort()).toEqual(['stage-web', 'stage-worker'])
    expect(await store.envByName(app.id, 'staging')).toBeUndefined()
    expect((await store.envByName(app.id, 'main'))?.active_box_id).toBe('web')
  })
})
