import { randomUUID } from 'node:crypto'
import { DataSource, type MigrationInterface, type QueryRunner } from 'typeorm'
import { Volume } from '../box/entities/volume.entity'
import { VolumeState } from '../box/enums/volume-state.enum'
import { BoxState } from '../box/enums/box-state.enum'
import { VolumeService } from '../box/services/volume.service'
import { Context } from '../common/context/context'
import { AddAppVolumeOwnership1794480000000 } from '../migrations/pre-deploy/1794480000000-add-app-volume-ownership-migration'
import { DropAppVolumeMappings1794480001000 } from '../migrations/post-deploy/1794480001000-drop-app-volume-mappings-migration'
import { CloudAppResources } from './cloud-app-resources'
import { volumeMounts, deleteVolumes } from './engine/resources/volumes'
import type { AppRow, EnvRow } from './engine/db'
import type { Ctx } from './engine/ctx'

const describeDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `app_volumes_${randomUUID().replaceAll('-', '')}`
const engineSchema = `${schema}_engine`
const organizationId = randomUUID()
const otherOrganizationId = randomUUID()
const volumeId = randomUUID()
const ordinaryId = randomUUID()
const app = { id: 'app_a', name: 'demo', org_id: organizationId } as AppRow
const environment = { id: 'env_main', app_id: app.id, name: 'main' } as EnvRow
const staging = { ...environment, id: 'env_staging', name: 'staging' }
const scoped = (sql: string) => sql.replaceAll('cloud_app.', `"${engineSchema}".`)
jest.setTimeout(30000)

describeDatabase('App volume ownership (PostgreSQL)', () => {
  let source: DataSource
  let volumes: VolumeService
  const expand = new AddAppVolumeOwnership1794480000000()
  const contract = new DropAppVolumeMappings1794480001000()

  beforeAll(async () => {
    source = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Volume],
      synchronize: false,
      extra: { options: `-c search_path=${schema},public` },
    }).initialize()
    source.manager.query = (sql, parameters) => source.query(scoped(sql), parameters)
  })

  afterAll(async () => {
    if (!source?.isInitialized) return
    try {
      await source.query(`DROP SCHEMA IF EXISTS "${engineSchema}" CASCADE; DROP SCHEMA IF EXISTS "${schema}" CASCADE;`)
    } finally {
      await source.destroy()
    }
  })

  beforeEach(async () => {
    await source.query(`DROP SCHEMA IF EXISTS "${engineSchema}" CASCADE;
      DROP SCHEMA IF EXISTS "${schema}" CASCADE;
      CREATE SCHEMA "${schema}"; CREATE SCHEMA "${engineSchema}";
      CREATE TABLE volume (id uuid PRIMARY KEY, "organizationId" uuid, name varchar NOT NULL,
        state varchar NOT NULL DEFAULT 'ready', "errorReason" varchar, "lastUsedAt" timestamp,
        "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
      CREATE TABLE box (id text PRIMARY KEY, "organizationId" uuid, volumes jsonb NOT NULL DEFAULT '[]',
        "desiredState" varchar NOT NULL DEFAULT 'started');`)
    await source.query(
      scoped(`CREATE TABLE cloud_app.apps (id text PRIMARY KEY, name text, org_id uuid, deleted_at timestamptz);
      CREATE TABLE cloud_app.envs (id text PRIMARY KEY, app_id text REFERENCES cloud_app.apps(id), name text, box_id text);
      CREATE TABLE cloud_app.env_volumes (env_id text REFERENCES cloud_app.envs(id), name text, volume_id text,
        created_at timestamptz DEFAULT now(), PRIMARY KEY(env_id,name));`),
    )
    await source.query(
      scoped('INSERT INTO cloud_app.apps (id, name, org_id) VALUES ($1,$2,$3),($4,$5,$3),($6,$5,$7)'),
      [app.id, app.name, organizationId, 'app_b', 'other', 'app_foreign', otherOrganizationId],
    )
    await source.query(
      scoped(`INSERT INTO cloud_app.envs (id, app_id, name, box_id)
      VALUES ($1,$2,'main','box_a'),($3,$2,'staging','box_stage'),('env_b','app_b','main','box_b'),
        ('env_foreign','app_foreign','main',NULL)`),
      [environment.id, app.id, staging.id],
    )
    await source.query(
      `INSERT INTO volume (id, "organizationId", name) VALUES ($1,$2,'mc-demo-main-uploads'),($3,$2,'shared')`,
      [volumeId, organizationId, ordinaryId],
    )
    await source.query(scoped('INSERT INTO cloud_app.env_volumes (env_id,name,volume_id) VALUES ($1,$2,$3)'), [
      environment.id,
      'mc-demo-main-uploads',
      volumeId,
    ])
    volumes = new VolumeService(
      source.getRepository(Volume),
      {} as never,
      { assertOrganizationIsNotSuspended: () => undefined } as never,
      { get: () => 'gcs' } as never,
      {} as never,
    )
  })

  async function migrate(migration: MigrationInterface, direction: 'up' | 'down' = 'up') {
    const runner = source.createQueryRunner()
    await runner.startTransaction()
    try {
      await migration[direction]({ query: (sql, parameters) => runner.query(scoped(sql), parameters) } as QueryRunner)
      await runner.commitTransaction()
    } catch (error) {
      await runner.rollbackTransaction()
      throw error
    } finally {
      await runner.release()
    }
  }

  it('backfills owners, preserves organization volumes and removes the mapping table', async () => {
    await migrate(expand)
    await migrate(contract)
    expect(await volumes.findOne(volumeId)).toMatchObject({
      targetType: 'app',
      appId: app.id,
      environmentId: environment.id,
    })
    expect(await volumes.findOne(ordinaryId)).toMatchObject({ targetType: 'box', appId: null, environmentId: null })
    expect(await source.query('SELECT to_regclass($1) AS name', [`${engineSchema}.env_volumes`])).toEqual([
      { name: null },
    ])
    await expect(volumes.validateVolumes(organizationId, [volumeId], staging.id)).resolves.toEqual(
      new Map([[volumeId, volumeId]]),
    )
    await expect(volumes.validateVolumes(organizationId, [volumeId])).rejects.toMatchObject({ status: 403 })
    await expect(volumes.validateVolumes(organizationId, [volumeId], 'env_b')).rejects.toMatchObject({ status: 403 })
    await expect(volumes.validateVolumes(otherOrganizationId, [volumeId], 'env_foreign')).rejects.toMatchObject({
      status: 404,
    })
    await expect(volumes.validateVolumes(organizationId, [ordinaryId])).resolves.toEqual(
      new Map([[ordinaryId, ordinaryId]]),
    )
    await expect(source.query('UPDATE volume SET environment_id = NULL WHERE id=$1', [volumeId])).rejects.toThrow(
      'volume_target',
    )
    await migrate(contract, 'down')
    expect(await source.query(scoped('SELECT volume_id FROM cloud_app.env_volumes'))).toEqual([{ volume_id: volumeId }])
    await migrate(expand, 'down')
    expect(
      await source.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND column_name=$2',
        [schema, 'target_type'],
      ),
    ).toEqual([])
  })

  it('captures mappings written by an old instance during rollout', async () => {
    await migrate(expand)
    await source.query(scoped('INSERT INTO cloud_app.env_volumes (env_id,name,volume_id) VALUES ($1,$2,$3)'), [
      staging.id,
      'shared',
      ordinaryId,
    ])
    await migrate(contract)
    expect(await volumes.findOne(ordinaryId)).toMatchObject({
      targetType: 'app',
      appId: app.id,
      environmentId: staging.id,
    })
  })

  it('rolls back a backfill when the volume already has a standalone Box consumer', async () => {
    await source.query('INSERT INTO box (id, volumes) VALUES ($1,$2)', ['standalone', JSON.stringify([{ volumeId }])])
    await expect(migrate(expand)).rejects.toThrow('outside the owning App')
    expect(
      await source.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND column_name=$2',
        [schema, 'target_type'],
      ),
    ).toEqual([])
    expect(await source.query(scoped('SELECT volume_id FROM cloud_app.env_volumes'))).toEqual([{ volume_id: volumeId }])
  })

  it('refuses ambiguous ownership without dropping the existing mappings', async () => {
    await source.query(scoped('INSERT INTO cloud_app.env_volumes (env_id,name,volume_id) VALUES ($1,$2,$3)'), [
      staging.id,
      'shared-uploads',
      volumeId,
    ])
    await expect(migrate(expand)).rejects.toThrow('multiple App environments')
    expect(await source.query(scoped('SELECT volume_id FROM cloud_app.env_volumes'))).toHaveLength(2)
  })

  it('rechecks existing Box consumers before contracting the old mapping table', async () => {
    await migrate(expand)
    await source.query('INSERT INTO box (id, volumes) VALUES ($1,$2)', ['standalone', JSON.stringify([{ volumeId }])])
    await expect(migrate(contract)).rejects.toThrow('outside the owning App')
    expect(await source.query(scoped('SELECT volume_id FROM cloud_app.env_volumes'))).toEqual([{ volume_id: volumeId }])
  })

  it('keeps ownership consistent when the same App already shares a volume between Boxes', async () => {
    await source.query('INSERT INTO box (id, volumes) VALUES ($1,$3),($2,$3)', [
      'box_a',
      'box_stage',
      JSON.stringify([{ volumeId }]),
    ])
    await migrate(expand)
    await migrate(contract)
    expect(await volumes.findOne(volumeId)).toMatchObject({ appId: app.id, environmentId: environment.id })
  })

  it('provisions and lists volumes by ownership and cleans up only the selected environment', async () => {
    await migrate(expand)
    await migrate(contract)
    const deleted: string[] = []
    jest.spyOn(volumes, 'waitForReady').mockImplementation(async (id) => {
      await source.getRepository(Volume).update(id, { state: VolumeState.READY })
      return volumes.findOne(id)
    })
    jest.spyOn(volumes, 'delete').mockImplementation(async (id) => {
      deleted.push(id)
    })
    const box = { id: 'new-app-box', name: 'demo-main', state: BoxState.STARTED }
    const resources = new CloudAppResources(
      {
        create: async (dto, _organization, _context, options) => {
          await volumes.validateVolumes(
            organizationId,
            dto.volumes.map((volume) => volume.volumeId),
            options.appEnvironmentId,
          )
          return box
        },
        findOneByIdOrName: async () => box,
        toBoxDto: async () => box,
      } as never,
      volumes,
      {} as never,
      { waitForStarted: async () => undefined } as never,
      { findOne: async () => ({ id: organizationId }), assertOrganizationIsNotSuspended: () => undefined } as never,
      { resolveMaxCreatedBoxes: async () => undefined } as never,
      source,
      {} as never,
    )
    const adapter = resources.volumesForOrganization(organizationId)
    const ctx = { volumes: adapter } as unknown as Ctx
    const mounts = await volumeMounts(
      ctx,
      app,
      environment,
      [{ name: 'uploads', mount: '/data', mode: 'rw', from: null, path: null }],
      () => undefined,
    )
    expect(mounts).toEqual([{ managed_volume: volumeId, guest_path: '/data' }])
    await expect(
      resources.forOrganization(organizationId).createBox({
        name: 'demo-main',
        image: 'node:test',
        cpus: 1,
        memory_mib: 1024,
        disk_size_gb: 10,
        env: { BOXLITE_ENV_ID: environment.id },
        cmd: [],
        auto_stop: 900,
        auto_resume: true,
        network: { inbound: { mode: 'enabled' } },
        volumes: mounts,
      }),
    ).resolves.toMatchObject({ id: box.id })
    const next = await adapter.create(app, staging, 'stage-uploads')
    expect(await volumes.findOne(next.id)).toMatchObject({
      targetType: 'app',
      appId: app.id,
      environmentId: staging.id,
    })
    await deleteVolumes(ctx, app, environment)
    expect(deleted).toEqual([volumeId])
    expect((await adapter.list(app, staging)).map((volume) => volume.id)).toContain(next.id)
    await expect(adapter.remove(app, environment, next.id)).rejects.toMatchObject({ status: 404 })
    await expect(
      volumes.create({ id: organizationId } as never, { name: 'wrong-owner' }, Context.user(), {
        appId: 'app_b',
        environmentId: environment.id,
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})
