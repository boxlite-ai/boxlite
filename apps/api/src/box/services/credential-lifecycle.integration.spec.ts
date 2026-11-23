import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { AddSecretCredential1794873600000 } from '../../migrations/pre-deploy/1794873600000-add-secret-credential-migration'
import { SecretCredentialService } from './secret-credential.service'
import { BoxService } from './box.service'
import { JobService } from './job.service'
import { Job } from '../entities/job.entity'
import { RunnerAdapterV2 } from '../runner-adapter/runnerAdapter.v2'
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
})
