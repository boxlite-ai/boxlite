import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddSecretCredential1794873600000 } from '../../migrations/pre-deploy/1794873600000-add-secret-credential-migration'
import { SecretCredentialService } from './secret-credential.service'
import { BoxService } from './box.service'
import { JobService } from './job.service'
import { Job } from '../entities/job.entity'
import { RunnerAdapterV2 } from '../runner-adapter/runnerAdapter.v2'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobConflictError } from '../errors/job-conflict.error'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxCheckpointState } from '../entities/box-checkpoint-state.entity'
import { BoxRepository } from '../repositories/box.repository'
import { Context } from '../../common/context/context'
;(process.env.DB_HOST ? describe : describe.skip)('Credential lifecycle transactions', () => {
  let db: DataSource
  let credentials: SecretCredentialService
  let repository: BoxRepository
  let box: Box
  const schema = `credential_lifecycle_${randomUUID().replaceAll('-', '')}`
  const binding = {
    runnerId: randomUUID(),
    boxId: 'box-review',
    organizationId: randomUUID(),
    secretIds: [randomUUID()],
  }
  beforeAll(async () => {
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Job, Box, BoxLastActivity, BoxCheckpointState],
      entitySkipConstructor: true,
      extra: { application_name: schema, options: `-c search_path=${schema},public` },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    await db.query(
      'CREATE TABLE organization_activation_facts ("organizationId" uuid PRIMARY KEY, "lastBoxCreatedAt" timestamptz, "lastBoxModifiedAt" timestamptz)',
    )
    repository = new BoxRepository(
      db,
      { emit: jest.fn() } as any,
      { invalidate: jest.fn(), invalidateOrgId: jest.fn() } as any,
    )
    const qr = db.createQueryRunner()
    try {
      await new AddSecretCredential1794873600000().up(qr)
    } finally {
      await qr.release()
    }
    credentials = new SecretCredentialService(db)
  })
  beforeEach(async () => {
    await db.query('TRUNCATE box CASCADE')
    await db.query('TRUNCATE job')
    box = new Box('us', 'credential-test')
    Object.assign(box, {
      organizationId: binding.organizationId,
      runnerId: binding.runnerId,
      osUser: 'root',
      labels: {},
      pending: false,
      state: BoxState.STOPPED,
      desiredState: BoxDesiredState.STOPPED,
    })
    await db.getRepository(Box).save(box)
    binding.boxId = box.id
  })
  afterAll(async () => {
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`)
      await db.destroy()
    }
  })
  function lifecycleService(): BoxService {
    const boxes = Object.create(BoxService.prototype)
    Object.assign(boxes, {
      findOneByIdOrName: async () => repository.findOneBy({ id: box.id }),
      boxRepository: repository,
      eventEmitter: { emit: jest.fn() },
    })
    return boxes
  }
  it('deleted Box credential should be inactive', async () => {
    const issued = await credentials.issue(binding)
    await lifecycleService().destroy(box.id, box.organizationId, Context.user())
    expect((await db.query('SELECT "desiredState" FROM box'))[0].desiredState).toBe(BoxDesiredState.DESTROYED)
    expect(await credentials.consume(issued.token, binding.runnerId)).toEqual({ active: false })
  })
  it('duplicate rejected job should leave exactly one credential', async () => {
    const jobs = new JobService(db.getRepository(Job), { lpush: jest.fn() } as any, {} as any)
    const adapter = new RunnerAdapterV2(repository, db.getRepository(Job), jobs)
    Object.assign(adapter, { config: { get: () => true }, credentials })
    await adapter.init({ id: binding.runnerId } as any)
    const box = {
      id: binding.boxId,
      organizationId: binding.organizationId,
      secrets: [{ secretId: binding.secretIds[0], name: 'review' }],
    } as any
    await adapter.createBox(box, 'base')
    await expect(adapter.createBox(box, 'base')).rejects.toBeInstanceOf(JobConflictError)
    expect(await db.getRepository(Job).count()).toBe(1)
    expect((await db.query('SELECT id FROM secret_credential')).length).toBe(1)
  })
  it('refuses issuance after deletion without inserting a credential', async () => {
    await lifecycleService().destroy(box.id, box.organizationId, Context.user())
    await expect(credentials.issue(binding)).rejects.toThrow('Could not issue secret credential')
    expect(await db.query('SELECT id FROM secret_credential')).toEqual([])
  })

  it.each(['runnerId', 'organizationId'] as const)('refuses a stale %s binding', async (field) => {
    await expect(credentials.issue({ ...binding, [field]: randomUUID() })).rejects.toThrow(
      'Could not issue secret credential',
    )
    expect(await db.query('SELECT id FROM secret_credential')).toEqual([])
  })

  it('rolls deletion back if credential revocation fails', async () => {
    const issued = await credentials.issue(binding)
    await db.query(`CREATE FUNCTION reject_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test revocation failure'; END $$`)
    await db.query(
      'CREATE TRIGGER reject_revocation BEFORE DELETE ON secret_credential FOR EACH ROW EXECUTE FUNCTION reject_revocation()',
    )
    try {
      await expect(lifecycleService().destroy(box.id, box.organizationId, Context.user())).rejects.toThrow(
        'test revocation failure',
      )
      expect((await repository.findOneBy({ id: box.id })).desiredState).toBe(BoxDesiredState.STOPPED)
      expect(await credentials.consume(issued.token, binding.runnerId)).toMatchObject({ active: true })
    } finally {
      await db.query('DROP TRIGGER reject_revocation ON secret_credential')
      await db.query('DROP FUNCTION reject_revocation()')
    }
  })
  it('waits for an in-flight deletion and refuses issuance after it commits', async () => {
    const deletion = db.createQueryRunner()
    await deletion.startTransaction()
    let issuing: Promise<unknown> | undefined
    try {
      await deletion.query('SELECT id FROM box WHERE id = $1 FOR UPDATE', [box.id])
      issuing = credentials.issue(binding).catch((error) => error)
      const deadline = Date.now() + 3000
      let blocked = false
      while (Date.now() < deadline) {
        const [row] = await db.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE 'SELECT id FROM box WHERE%') AS blocked",
          [schema],
        )
        if (row.blocked) {
          blocked = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(blocked).toBe(true)
      await deletion.query('UPDATE box SET "desiredState" = \'destroyed\' WHERE id = $1', [box.id])
      await deletion.commitTransaction()
      expect(await issuing).toMatchObject({ message: 'Could not issue secret credential' })
      expect(await db.query('SELECT id FROM secret_credential')).toEqual([])
    } finally {
      if (deletion.isTransactionActive) await deletion.rollbackTransaction()
      await deletion.release()
      await issuing
    }
  })
  it.each([true, false])('notifies after job visibility and Box lock release with credentials=%s', async (enabled) => {
    let atNotification: { jobs: number; boxLocked: boolean } | undefined
    const jobs = new JobService(
      db.getRepository(Job),
      {
        lpush: async () => {
          const observer = db.createQueryRunner()
          await observer.startTransaction()
          try {
            const [{ count }] = await observer.query('SELECT count(*)::int FROM job')
            let boxLocked = false
            try {
              await observer.query('SELECT id FROM box WHERE id = $1 FOR UPDATE NOWAIT', [box.id])
            } catch (error) {
              if (error.code !== '55P03') throw error
              boxLocked = true
            }
            atNotification = { jobs: count, boxLocked }
          } finally {
            await observer.rollbackTransaction()
            await observer.release()
          }
        },
      } as any,
      {} as any,
    )
    const adapter = new RunnerAdapterV2(repository, db.getRepository(Job), jobs)
    Object.assign(adapter, { config: { get: () => enabled }, credentials })
    await adapter.init({ id: binding.runnerId } as any)
    await adapter.createBox(
      { ...box, secrets: enabled ? [{ secretId: binding.secretIds[0], name: 'test' }] : [] } as any,
      'base',
    )
    expect(await db.getRepository(Job).count()).toBe(1)
    expect(atNotification).toEqual({ jobs: 1, boxLocked: false })
  })

  it('revokes by box_id without scanning unrelated credentials', async () => {
    await credentials.issue(binding)
    const other = Object.assign(new Box('us', 'other'), box, {
      id: new Box('us', 'other').id,
      name: 'other',
      authToken: randomUUID(),
    })
    await db.getRepository(Box).save(other)
    await db.query(
      `INSERT INTO secret_credential(token_hash,runner_id,box_id,organization_id,grants,expires_at)
      SELECT decode(md5(i::text),'hex'),$1,$2,$3,'[]'::jsonb,now()+interval '15 minutes'
      FROM generate_series(1,10000) i`,
      [binding.runnerId, other.id, binding.organizationId],
    )
    await db.query('ANALYZE secret_credential')
    const qr = db.createQueryRunner()
    await qr.startTransaction()
    try {
      const rows = await qr.query(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM secret_credential WHERE box_id=$1',
        [box.id],
      )
      const scan = rows[0]['QUERY PLAN'][0].Plan.Plans[0]
      expect(scan['Actual Rows']).toBe(1)
      expect(scan['Node Type']).not.toBe('Seq Scan')
    } finally {
      await qr.rollbackTransaction()
      await qr.release()
    }
  })
  it('does not notify when a transaction rolls back after job insertion', async () => {
    const lpush = jest.fn()
    const jobs = new JobService(db.getRepository(Job), { lpush } as any, {} as any)
    await expect(
      db.transaction(async (manager) => {
        await jobs.createJob(manager, JobType.CREATE_BOX, binding.runnerId, ResourceType.BOX, box.id)
        throw new Error('rollback after insert')
      }),
    ).rejects.toThrow('rollback after insert')
    expect(await db.getRepository(Job).count()).toBe(0)
    expect(lpush).not.toHaveBeenCalled()
  })
  it('retains a discoverable committed job when Redis notification fails', async () => {
    const jobs = new JobService(
      db.getRepository(Job),
      {
        lpush: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
        del: jest.fn(),
      } as any,
      {} as any,
    )
    const adapter = new RunnerAdapterV2(repository, db.getRepository(Job), jobs)
    Object.assign(adapter, { config: { get: () => true }, credentials })
    await adapter.init({ id: binding.runnerId } as any)
    await adapter.createBox({ ...box, secrets: [{ secretId: binding.secretIds[0], name: 'test' }] } as any, 'base')
    const polled = await jobs.pollJobs(binding.runnerId)
    expect(polled).toHaveLength(1)
    expect(polled[0].resourceId).toBe(box.id)
    expect(await db.getRepository(Job).count()).toBe(1)
    expect((await db.query('SELECT id FROM secret_credential')).length).toBe(1)
  })
})
