import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DataSource } from 'typeorm'
import migrationSource, { baseDataSourceOptions } from './data-source'
import { IndexBoxOrganizationForProxy1795000000000 } from './pre-deploy/1795000000000-index-box-organization-for-proxy-migration'

const databaseSuite = process.env.DB_HOST ? describe : describe.skip
const MigrationDataSource = migrationSource.constructor as typeof DataSource
const registryMigrations = join(__dirname, 'pre-deploy/179500000[01]*-migration.{ts,js}')

databaseSuite('Registry migration at API startup (PostgreSQL)', () => {
  let schema: string
  let fixture: DataSource
  let sources: DataSource[]

  function source(
    migrations: Array<string | typeof IndexBoxOrganizationForProxy1795000000000>,
    migrationsRun: boolean,
    applicationName?: string,
  ) {
    if (baseDataSourceOptions.type !== 'postgres') throw new Error('Requires PostgreSQL migration options')
    const database = new MigrationDataSource({
      ...baseDataSourceOptions,
      schema,
      applicationName,
      entities: [],
      extra: { options: `-c search_path=${schema},public`, max: 1 },
      migrations,
      migrationsRun,
    })
    sources.push(database)
    return database
  }

  beforeEach(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST ?? '')) {
      throw new Error('Requires loopback PostgreSQL')
    }
    schema = `registry_startup_${randomUUID().replaceAll('-', '')}`
    sources = []
    fixture = await source([], false).initialize()
    await fixture.query(`CREATE SCHEMA "${schema}"`)
    await fixture.query('CREATE TABLE organization (id uuid PRIMARY KEY)')
    await fixture.query('CREATE TABLE box (id varchar PRIMARY KEY, "organizationId" uuid NOT NULL)')
  })

  afterEach(async () => {
    if (fixture?.isInitialized) {
      await fixture.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
    await Promise.all(sources.filter((database) => database.isInitialized).map((database) => database.destroy()))
  })

  function validatedReference() {
    return fixture.query(`
      SELECT convalidated AS validated
      FROM pg_constraint
      WHERE contype = 'f'
        AND conrelid = 'outbound_proxy_reference'::regclass
        AND confrelid = 'box'::regclass
    `)
  }

  it.each(['missing', 'invalid'])('restores a %s index whose migration is recorded', async (indexState) => {
    const initial = await source([IndexBoxOrganizationForProxy1795000000000], true).initialize()
    expect(await initial.showMigrations()).toBe(false)
    await fixture.query('DROP INDEX CONCURRENTLY box_organization_id_proxy_idx')
    if (indexState === 'invalid') {
      const blocker = fixture.createQueryRunner()
      const builder = (await source([], false).initialize()).createQueryRunner()
      try {
        await blocker.startTransaction()
        await blocker.query('LOCK TABLE box IN ROW EXCLUSIVE MODE')
        await builder.query("SET statement_timeout = '500ms'")
        await expect(new IndexBoxOrganizationForProxy1795000000000().up(builder)).rejects.toMatchObject({
          code: '57014',
        })
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction()
        await Promise.all([blocker.release(), builder.release()])
      }
      expect(
        await fixture.query(`
        SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'box_organization_id_proxy_idx'::regclass
      `),
      ).toEqual([{ valid: false }])
    }

    await source([registryMigrations], true).initialize()

    expect(await validatedReference()).toEqual([{ validated: true }])
    expect(
      await fixture.query(
        `
      SELECT count(*)::int AS records FROM migrations WHERE name = $1
    `,
        [IndexBoxOrganizationForProxy1795000000000.name],
      ),
    ).toEqual([{ records: 1 }])
  })

  it('serializes two startup migrations before they read the same pending history', async () => {
    await fixture.query(
      'CREATE TABLE migrations (id serial PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL)',
    )
    const observer = await source([], false).initialize()
    const blocker = fixture.createQueryRunner()
    const names = [`${schema}_a`, `${schema}_b`]
    await blocker.startTransaction()
    let starts: Promise<PromiseSettledResult<DataSource>[]> | undefined
    try {
      await blocker.query('LOCK TABLE migrations IN ACCESS EXCLUSIVE MODE')
      starts = Promise.allSettled(names.map((name) => source([registryMigrations], true, name).initialize()))
      const deadline = Date.now() + 4000
      let contenders = 0
      while (contenders < 2 && Date.now() < deadline) {
        const [snapshot] = await observer.query(
          `
          SELECT count(*)::int AS contenders FROM pg_stat_activity
          WHERE application_name = ANY($1)
            AND (query LIKE '%pg_try_advisory_lock%' OR (query LIKE '%migrations%' AND wait_event_type = 'Lock'))
        `,
          [names],
        )
        contenders = snapshot.contenders
        if (contenders < 2) await delay(25)
      }
      expect(contenders).toBe(2)
    } finally {
      await blocker.rollbackTransaction()
      await blocker.release()
    }
    const outcomes = await starts
    expect(outcomes?.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(await validatedReference()).toEqual([{ validated: true }])
    expect(await fixture.query('SELECT name FROM migrations GROUP BY name HAVING count(*) <> 1')).toEqual([])
  }, 15000)

  it('preserves populated Registry tables and history when schema rollback is requested', async () => {
    const registry = await source([registryMigrations], true).initialize()
    const org = randomUUID()
    const registration = randomUUID()
    await fixture.query('INSERT INTO organization VALUES ($1)', [org])
    await fixture.query('INSERT INTO box (id, "organizationId") VALUES ($1, $2)', ['test-box', org])
    await fixture.transaction(async (tx) => {
      await tx.query(
        `
        INSERT INTO outbound_proxy_registration (organization_id, id, name, current_revision)
        VALUES ($1, $2, 'proxy-test', 1)
      `,
        [org, registration],
      )
      await tx.query(
        `
        INSERT INTO outbound_proxy_revision (organization_id, registration_id, revision, url)
        VALUES ($1, $2, 1, 'https://example.test')
      `,
        [org, registration],
      )
    })
    await fixture.query(
      `
      INSERT INTO outbound_proxy_reference
        (organization_id, box_id, kind, registration_id, revision, runner_id, runtime_epoch, attempt_id)
      VALUES ($1, 'test-box', 'committed', $2, 1, 'runner', 'epoch', 'committed-attempt'),
             ($1, 'test-box', 'pending', $2, 1, 'runner', 'epoch', 'pending-attempt')
    `,
      [org, registration],
    )

    const history = await fixture.query('SELECT name FROM migrations ORDER BY id')
    await expect(registry.undoLastMigration({ transaction: 'each' })).rejects.toThrow(
      'populated outbound proxy Registry',
    )
    expect(await fixture.query('SELECT kind FROM outbound_proxy_reference ORDER BY kind')).toEqual([
      { kind: 'committed' },
      { kind: 'pending' },
    ])
    expect(await fixture.query('SELECT name FROM migrations ORDER BY id')).toEqual(history)
  })
})
