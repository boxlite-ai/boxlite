import { createHash, randomUUID } from 'node:crypto'
import { createServer, Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { PassportModule } from '@nestjs/passport'
import { Test } from '@nestjs/testing'
import { DataSource } from 'typeorm'
import { ApiKeyStrategy } from '../../auth/api-key.strategy'
import { JwtStrategy } from '../../auth/jwt.strategy'
import { Context } from '../../common/context/context'
import type { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { AddCompleteOutboundAdmission1795096802000 } from '../../migrations/pre-deploy/1795096802000-add-complete-outbound-admission-migration'
import { AddCompleteOutboundEnrollmentAndClaims1795096803000 } from '../../migrations/pre-deploy/1795096803000-add-complete-outbound-enrollment-and-claims-migration'
import { AddPendingCompleteV2CreateIndex1795096804000 } from '../../migrations/pre-deploy/1795096804000-add-pending-complete-v2-create-index-migration'
import { AddCompleteOutboundReleaseControl1795096806000 } from '../../migrations/pre-deploy/1795096806000-add-complete-outbound-release-control-migration'
import { CompleteCreateJobController } from '../controllers/complete-create-job.controller'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { CompleteCreateIntent } from '../entities/outbound-control-record'
import { Runner } from '../entities/runner.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { CompleteCreateAttempt, CompleteCreateBox } from '../runner-adapter/outbound-control'
import { OutboundPolicyStore, requireCompleteOutboundAdmission } from '../stores/outbound-policy.store'
import { BoxService } from './box.service'
import { CompleteCreateJobService } from './complete-create-job.service'
import { JobService } from './job.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schema = `complete_job_${process.pid}_${randomUUID().replaceAll('-', '')}`
const organizationId = randomUUID()
const token = 'a'.repeat(43)
const controlKey = 'synthetic-runner-api-key'
const release = 'synthetic-compatible-release'
const completePolicy = { mode: 'enabled' as const, allow_net: [], deny_net: [] }

describeIfDatabase('complete V2 job ownership (real PostgreSQL)', () => {
  let db: DataSource
  let store: OutboundPolicyStore
  let boxRepository: BoxRepository
  let ordinary: JobService
  let jobs: CompleteCreateJobService
  let runner: Runner
  let context: RunnerContext
  let peer: Server
  let cancelProof: (attempt: CompleteCreateAttempt) => Promise<object>
  let prepare: (payload: object, revision: string) => Promise<object>
  const emit = jest.fn()

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '::1'].includes(process.env.DB_HOST)) {
      throw new Error('Requires loopback PostgreSQL')
    }
    db = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema,
      entities: [Box, BoxLastActivity, Job, Runner],
      entitySkipConstructor: true,
      ssl: false,
      extra: { options: `-c search_path=${schema},public`, connectionTimeoutMillis: 3000, query_timeout: 10000 },
    }).initialize()
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.synchronize()
    const migration = db.createQueryRunner()
    try {
      await migration.query('ALTER TABLE "job" DROP "completeOutboundReconciling"')
      await new AddCompleteOutboundAdmission1795096802000().up(migration)
      await new AddCompleteOutboundEnrollmentAndClaims1795096803000().up(migration)
      await new AddPendingCompleteV2CreateIndex1795096804000().up(migration)
      await new AddCompleteOutboundReleaseControl1795096806000().up(migration)
    } finally {
      await migration.release()
    }
    store = new OutboundPolicyStore(db)
    boxRepository = new BoxRepository(
      db,
      { emit } as never,
      {
        invalidate: jest.fn(),
        invalidateOrgId: jest.fn(),
      } as never,
    )
    ordinary = new JobService(
      db.getRepository(Job),
      {
        lpush: jest.fn(),
        del: jest.fn(),
        duplicate: () => ({ brpop: async () => null, disconnect: jest.fn() }),
      } as never,
      {} as never,
    )
    peer = createServer((req, res) => {
      void (async () => {
        expect(req.method).toBe('POST')
        expect(req.headers.authorization).toBe(`Bearer ${controlKey}`)
        const data: Buffer[] = []
        for await (const chunk of req) data.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(data).toString())
        if (req.url?.endsWith('/complete/prepare-create')) {
          const revision = req.headers['x-boxlite-outbound-revision'] as string
          res.end(JSON.stringify(await prepare(body, revision)))
          return
        }
        const attempt: CompleteCreateAttempt = body
        expect(req.url).toBe(`/v1/boxes/${attempt.incarnation}/network/outbound/complete/cancel-create`)
        res.end(JSON.stringify(await cancelProof(attempt)))
      })().catch((error) => res.writeHead(500).end(String(error)))
    })
    await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  }, 20000)

  beforeEach(async () => {
    emit.mockClear()
    jobs = new CompleteCreateJobService(db, boxRepository, ordinary, {
      createConfiguration: async () => ({ image: 'pinned-base', metadata: { fixture: 'fixture' }, nested: false }),
    } as never)
    await db.query('TRUNCATE "job", "box", "box_last_activity", "runner", complete_outbound_runner_enrollment')
    await db.query(
      "UPDATE complete_outbound_admission SET phase = 'open', minimum_release = $1, api_principal = current_user, deployment_receipt = 'fixture' WHERE id = 1",
      [release],
    )
    runner = await db.getRepository(Runner).save(
      new Runner({
        region: 'local',
        name: 'runner',
        apiKey: controlKey,
        apiUrl: `http://127.0.0.1:${(peer.address() as AddressInfo).port}`,
        apiVersion: '2',
      }),
    )
    context = { role: 'runner', runnerId: runner.id, runner }
    cancelProof = async (attempt) => ({ attempt, outcome: 'pending' })
    prepare = async () => {
      throw new Error('Unexpected prepare')
    }
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    if (peer?.listening) {
      peer.closeAllConnections()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
    }
    if (db?.isInitialized) {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await db.destroy()
    }
  })

  async function enroll() {
    await db.query(
      `INSERT INTO complete_outbound_runner_enrollment (runner_id, lease_id, token_sha256, verified_floor, runner_key_sha256, expires_at)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '1 hour')`,
      [
        runner.id,
        randomUUID(),
        createHash('sha256').update(token).digest('hex'),
        release,
        createHash('sha256').update(controlKey).digest('hex'),
      ],
    )
  }

  function reservation() {
    const box = Object.assign(new Box('local', randomUUID()), {
      organizationId,
      name: 'complete-job',
      runnerId: runner.id,
      image: 'base',
      osUser: 'boxlite',
      state: BoxState.UNKNOWN,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    const owner: Extract<CompleteCreateIntent, { transport: 'v2' }> = {
      kind: 'create',
      transport: 'v2',
      incarnation: box.id,
      runnerId: runner.id,
      attemptId: randomUUID(),
      jobId: randomUUID(),
      claimId: randomUUID(),
      generation: 1,
      candidate: {
        deny_present: true,
        snapshot: {
          revision: randomUUID(),
          admission: 'extended_ipv4',
          policy: { mode: 'enabled', allow_net: [], deny_net: [] },
        },
      },
    }
    const configuration: CompleteCreateBox = {
      id: box.id,
      image: box.image,
      osUser: box.osUser,
      cpuQuota: 1,
      memoryQuota: 1,
      storageQuota: 3,
    }
    return {
      box,
      owner,
      reserve: async (afterEnqueue?: () => Promise<void>) => {
        const [enrollment] = await db.query(
          'SELECT lease_id FROM complete_outbound_runner_enrollment WHERE runner_id = $1',
          [runner.id],
        )
        const preparation = { runner, leaseId: enrollment?.lease_id ?? randomUUID() }
        return boxRepository.insertCompleteCreate(box, owner, preparation, undefined, async (manager) => {
          await jobs.enqueue(manager, owner, configuration)
          await afterEnqueue?.()
        })
      },
    }
  }

  it('commits the Box and job together and excludes the job from ordinary Runner delivery', async () => {
    const { box, owner, reserve } = reservation()
    await expect(reserve()).rejects.toMatchObject({ status: 503 })
    expect(await db.getRepository(Box).findOneBy({ id: box.id })).toBeNull()
    expect(await db.getRepository(Job).findOneBy({ id: owner.jobId })).toBeNull()
    await enroll()
    await reserve()
    expect((await store.read(box.id, organizationId)).completeOutboundControl?.pending).toEqual(owner)

    const legacy = await ordinary.createJob(null, JobType.CREATE_BOX, runner.id, ResourceType.BOX, 'legacy-box')
    expect((await ordinary.pollJobs(runner.id)).map(({ id }) => id)).toEqual([legacy.id])
    expect(await ordinary.pollJobs(runner.id)).toEqual([])

    await expect(jobs.claim(context, undefined)).rejects.toMatchObject({ status: 403 })
    await expect(jobs.claim(context, 'b'.repeat(43))).rejects.toMatchObject({ status: 403 })
    await db.getRepository(Runner).update(runner.id, { apiKey: 'rotated' })
    await expect(jobs.claim(context, token)).rejects.toMatchObject({ status: 403 })
    await db.getRepository(Runner).update(runner.id, { apiKey: controlKey })
    const claims = await Promise.all([jobs.claim(context, token), jobs.claim(context, token)])
    expect(claims.filter(Boolean)).toEqual([
      {
        attempt: {
          incarnation: box.id,
          attempt_id: owner.attemptId,
          generation: owner.generation,
          job_id: owner.jobId,
          claim_id: owner.claimId,
          prepared: owner.candidate,
        },
        box: expect.objectContaining({ id: box.id }),
      },
    ])
    expect((await ordinary.findJobsForRunner(runner.id, JobStatus.IN_PROGRESS)).items.map(({ id }) => id)).toEqual([
      legacy.id,
    ])
    await expect(ordinary.updateJobStatus(owner.jobId, JobStatus.COMPLETED)).rejects.toMatchObject({ status: 409 })
  })

  function createBoxWithCompletePolicy() {
    const service: BoxService = Object.assign(Object.create(BoxService.prototype), {
      boxRepository,
      completeCreateJobs: jobs,
      organizationService: {
        assertOrganizationIsNotSuspended: () => undefined,
        isNestedVirtualizationEnabled: async () => false,
      },
      getValidatedOrDefaultRegion: async () => ({ id: 'local' }),
      runnerService: { getRandomAvailableRunner: async () => runner },
      organizationBoxLimits: { resolve: async () => ({}) },
      imageAdmissionService: { assert: async () => undefined, spendColdPullBudget: async () => undefined },
      imageResolverService: { resolve: async () => ({ ref: 'base', isOrgOwned: false }) },
      eventEmitter: { emitAsync: async () => undefined },
      toBoxDto: async (box: Box) => ({ id: box.id }),
    })
    return service.create({ image: 'base' }, { id: organizationId } as never, Context.user(), {
      completeOutbound: completePolicy,
    })
  }

  it('routes an admitted V2 BoxService create through preparation and the protected queue', async () => {
    await enroll()
    prepare = async (body, revision) => {
      expect(body).toEqual(completePolicy)
      expect(await db.getRepository(Box).count()).toBe(0)
      expect(await db.getRepository(Job).count()).toBe(0)
      return { snapshot: { revision, admission: 'extended_ipv4', policy: completePolicy }, deny_present: true }
    }
    const created = await createBoxWithCompletePolicy()
    const row = await store.read(created.id, organizationId)
    const claim = await jobs.claim(context, token)
    expect(row.completeOutboundControl?.pending).toMatchObject({
      kind: 'create',
      transport: 'v2',
      jobId: claim.attempt.job_id,
    })
    expect(claim).toMatchObject({
      attempt: { prepared: { snapshot: { policy: completePolicy }, deny_present: true } },
      box: { id: created.id, image: 'pinned-base', metadata: { fixture: 'fixture' } },
    })
    expect(claim.box).not.toHaveProperty('outboundEnabled')
    expect(claim.box).not.toHaveProperty('outboundAllowNet')
  })

  it.each(['unenrolled Runner', 'Runner lease rotated', 'proxy-only endpoint changed'])(
    'refuses create with %s',
    async (state) => {
      const prepared = jest.fn(async (_body: object, revision: string) => ({
        snapshot: { revision, admission: 'extended_ipv4', policy: completePolicy },
        deny_present: true,
      }))
      prepare = prepared
      if (state !== 'unenrolled Runner') {
        await enroll()
        const runners = db.getRepository(Runner)
        if (state === 'proxy-only endpoint changed') {
          await runners.update(runner.id, { apiUrl: null, proxyUrl: runner.apiUrl })
        }
        const prepareBox = jobs.prepareBox.bind(jobs)
        jest.spyOn(jobs, 'prepareBox').mockImplementationOnce(async (box, verified) => {
          if (state === 'Runner lease rotated') {
            await db.query('UPDATE complete_outbound_runner_enrollment SET lease_id = $1', [randomUUID()])
          } else {
            await runners.update(runner.id, { proxyUrl: 'http://127.0.0.1:1' })
          }
          return prepareBox(box, verified)
        })
      }
      await expect(createBoxWithCompletePolicy()).rejects.toMatchObject({ status: 503 })
      expect(prepared).toHaveBeenCalledTimes(state === 'unenrolled Runner' ? 0 : 1)
      expect(await db.getRepository(Box).count()).toBe(0)
      expect(await db.getRepository(Job).count()).toBe(0)
    },
  )

  it('commits terminal evidence before publication and recovers it once after restart', async () => {
    await enroll()
    const { box, owner, reserve } = reservation()
    await reserve()
    const claim = await jobs.claim(context, token)
    const receipt = { attempt: claim.attempt, outcome: 'installed', snapshot: owner.candidate.snapshot }
    await expect(
      jobs.accept(context, token, owner.jobId, {
        ...receipt,
        attempt: { ...receipt.attempt, claim_id: randomUUID() },
      }),
    ).rejects.toMatchObject({ status: 503 })
    expect((await ordinary.findOne(owner.jobId)).status).toBe(JobStatus.IN_PROGRESS)
    const publish = jest
      .spyOn(boxRepository, 'settleCompleteCreate')
      .mockRejectedValueOnce(new Error('publisher interrupted'))
    await expect(jobs.accept(context, token, owner.jobId, receipt)).rejects.toThrow('publisher interrupted')
    expect((await ordinary.findOne(owner.jobId)).getResultMetadata()).toEqual(receipt)
    expect(await store.read(box.id, organizationId)).toMatchObject({ state: BoxState.UNKNOWN, pending: true })
    const restarted = new CompleteCreateJobService(db, boxRepository, ordinary, {} as never)
    await restarted.reconcile()
    await restarted.reconcile()
    await restarted.accept(context, token, owner.jobId, receipt)
    await expect(
      restarted.accept(context, token, owner.jobId, {
        attempt: receipt.attempt,
        outcome: 'no_effect',
      }),
    ).rejects.toMatchObject({ status: 409 })
    expect(await store.read(box.id, organizationId)).toMatchObject({
      state: BoxState.STARTED,
      pending: false,
      completeOutboundControl: { version: 2, committed: receipt.snapshot },
    })
    expect(publish).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls.filter(([type]) => type === 'box.state.updated')).toHaveLength(1)
  })

  it('serializes closing release admission with a Box and its V2 job', async () => {
    await enroll()
    const first = reservation()
    await first.reserve(async () => {
      await expect(db.query('SELECT id FROM complete_outbound_admission FOR UPDATE NOWAIT')).rejects.toMatchObject({
        code: '55P03',
      })
    })
    await db.query("UPDATE complete_outbound_admission SET phase = 'closed' WHERE id = 1")
    const second = reservation()
    await expect(second.reserve()).rejects.toMatchObject({ status: 503 })
    expect(await db.getRepository(Box).findOneBy({ id: second.box.id })).toBeNull()
    expect(await db.getRepository(Job).findOneBy({ id: second.owner.jobId })).toBeNull()
    expect((await jobs.claim(context, token)).attempt.job_id).toBe(first.owner.jobId)
  })

  it('closes never-delivered work after lease rotation and retains a delivered lease until recovery', async () => {
    await enroll()
    const first = reservation()
    await first.reserve()
    await db.query('UPDATE complete_outbound_runner_enrollment SET lease_id = $1', [randomUUID()])
    expect(await jobs.claim(context, token)).toBeNull()
    await jobs.reconcile()
    expect((await ordinary.findOne(first.owner.jobId)).status).toBe(JobStatus.FAILED)
    expect(await store.read(first.box.id, organizationId)).toMatchObject({ state: BoxState.ERROR, pending: false })
    const second = reservation()
    second.box.name = 'delivered-job'
    await second.reserve()
    const claim = await jobs.claim(context, token)
    expect(claim.attempt.job_id).toBe(second.owner.jobId)
    await expect(
      db.query('UPDATE complete_outbound_runner_enrollment SET lease_id = $1', [randomUUID()]),
    ).rejects.toThrow('Complete outbound work still owns the Runner lease')
    await jobs.accept(context, token, second.owner.jobId, { attempt: claim.attempt, outcome: 'no_effect' })
    await db.query('UPDATE complete_outbound_runner_enrollment SET lease_id = $1', [randomUUID()])
    expect((await ordinary.findOne(second.owner.jobId)).status).toBe(JobStatus.FAILED)
  })

  it('requires the complete serving cohort and pins admission to the configured PostgreSQL principal', async () => {
    const application = `${schema}_api`
    const retired = `${schema}_old`
    const connection = db.createQueryRunner()
    const activate = () =>
      db.query('SELECT complete_outbound_activate($1, $2, $3, $4)', [
        release,
        application,
        [retired],
        'verified-fixture-receipt',
      ])
    try {
      await db.query('SELECT complete_outbound_close()')
      await db.query(`CREATE ROLE "${application}" LOGIN`)
      await db.query(`CREATE ROLE "${retired}" LOGIN`)
      await db.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${application}"`)
      await expect(activate()).rejects.toThrow('old application principal')
      await db.query(`ALTER ROLE "${retired}" NOLOGIN`)
      await db.getRepository(Runner).update(runner.id, { state: RunnerState.READY })
      await expect(activate()).rejects.toThrow('cohort is incomplete')
      await enroll()
      await activate()
      await expect(requireCompleteOutboundAdmission(db.manager, false)).rejects.toMatchObject({ status: 503 })
      await connection.query(`SET ROLE "${application}"`)
      await expect(requireCompleteOutboundAdmission(connection.manager, true)).resolves.toBeUndefined()
      await expect(connection.query("UPDATE complete_outbound_admission SET phase = 'closed'")).rejects.toMatchObject({
        code: '42501',
      })
      await connection.query('RESET ROLE')
      await db.query('SELECT complete_outbound_close()')
      await expect(db.query('SELECT complete_outbound_begin_downgrade()')).rejects.toThrow('still blocks downgrade')
      await db.query(
        "UPDATE complete_outbound_runner_enrollment SET expires_at = clock_timestamp() - interval '1 second'",
      )
      await db.query('SELECT complete_outbound_begin_downgrade()')
      const [state] = await db.query('SELECT phase, minimum_release FROM complete_outbound_admission')
      expect(state).toEqual({ phase: 'downgrading', minimum_release: release })
    } finally {
      await connection.query('RESET ROLE').catch(() => undefined)
      await connection.release()
      await db.query(`DROP OWNED BY "${application}"`).catch(() => undefined)
      await db.query(`DROP ROLE IF EXISTS "${application}", "${retired}"`)
    }
  })

  it('requires both the authenticated Runner and its lease at the private HTTP routes', async () => {
    await enroll()
    const { box, owner, reserve } = reservation()
    await reserve()
    const fixtureConfig = { get: (key: string) => (key === 'proxy.apiKey' ? 'synthetic-proxy-key' : undefined) }
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ session: false })],
      controllers: [CompleteCreateJobController],
      providers: [
        { provide: CompleteCreateJobService, useValue: jobs },
        {
          provide: ApiKeyStrategy,
          useFactory: () =>
            new ApiKeyStrategy(
              { get: async () => null } as never,
              { getApiKeyByValue: async () => null } as never,
              {} as never,
              fixtureConfig as never,
              { findByApiKey: (apiKey: string) => db.getRepository(Runner).findOneBy({ apiKey }) } as never,
              { findOneByProxyApiKey: async () => null } as never,
            ),
        },
        {
          provide: JwtStrategy,
          useFactory: () =>
            new JwtStrategy(
              { issuer: 'http://127.0.0.1', audience: 'synthetic', jwksUri: 'http://127.0.0.1/jwks' },
              {} as never,
              fixtureConfig as never,
              {} as never,
            ),
        },
      ],
    }).compile()
    const app: INestApplication = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ transform: true }))
    await app.listen(0, '127.0.0.1')
    const request = (path: string, apiKey?: string, lease?: string, proof?: object) =>
      fetch(
        `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/jobs/complete-outbound/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...(lease ? { 'x-boxlite-complete-lease': lease } : {}),
          },
          ...(proof ? { body: JSON.stringify(proof) } : {}),
        },
      )
    try {
      expect((await request('claim', undefined, token)).status).toBe(401)
      expect((await request('claim', 'synthetic-proxy-key', token)).status).toBe(401)
      expect((await request('claim', controlKey)).status).toBe(403)
      const claimed = await request('claim', controlKey, token)
      expect(claimed.status).toBe(200)
      const { request: claim } = await claimed.json()
      expect(claim.attempt.job_id).toBe(owner.jobId)
      const receipt = { attempt: claim.attempt, outcome: 'installed', snapshot: owner.candidate.snapshot }
      const receiptPath = `${owner.jobId}/receipt`
      expect((await request(receiptPath, undefined, token, receipt)).status).toBe(401)
      expect((await request(receiptPath, controlKey, 'b'.repeat(43), receipt)).status).toBe(403)
      expect(await store.read(box.id, organizationId)).toMatchObject({ state: BoxState.UNKNOWN, pending: true })
      expect((await request(receiptPath, controlKey, token, receipt)).status).toBe(204)
      expect(await store.read(box.id, organizationId)).toMatchObject({ state: BoxState.STARTED, pending: false })
    } finally {
      await app.close()
    }
  })

  it.each(['installed', 'no_effect'] as const)(
    'reconciles an expired claim to %s only with a bound receipt',
    async (outcome) => {
      await enroll()
      const { box, owner, reserve } = reservation()
      await reserve()
      const claim = await jobs.claim(context, token)
      const old = new Date(Date.now() - 11 * 60_000)
      await db.query('UPDATE "job" SET "startedAt" = $1, "updatedAt" = $1 WHERE id = $2', [old, owner.jobId])
      await ordinary.handleStaleJobs()
      expect((await ordinary.findOne(owner.jobId)).status).toBe(JobStatus.IN_PROGRESS)
      const recoveryRequests: CompleteCreateAttempt[] = []
      cancelProof = async (attempt) => {
        recoveryRequests.push(attempt)
        return { attempt, outcome: 'pending' }
      }
      await jobs.reconcile()
      expect(recoveryRequests).toEqual([claim.attempt])
      const [duringRecovery] = await db.query('SELECT "completeOutboundReconciling" FROM "job" WHERE id = $1', [
        owner.jobId,
      ])
      expect(duringRecovery.completeOutboundReconciling).toBe(true)
      expect((await ordinary.findOne(owner.jobId)).status).toBe(JobStatus.IN_PROGRESS)
      expect(await jobs.claim(context, token)).toBeNull()
      expect(await store.read(box.id, organizationId)).toMatchObject({ state: BoxState.UNKNOWN, pending: true })
      const terminal =
        outcome === 'installed' ? { outcome, snapshot: owner.candidate.snapshot } : { outcome, failure: 'unsupported' }
      await expect(
        jobs.accept(context, token, owner.jobId, {
          attempt: claim.attempt,
          ...terminal,
        }),
      ).rejects.toMatchObject({ status: 409 })
      cancelProof = async (attempt) => ({ attempt: { ...attempt, claim_id: randomUUID() }, ...terminal })
      await jobs.reconcile()
      expect((await ordinary.findOne(owner.jobId)).status).toBe(JobStatus.IN_PROGRESS)
      cancelProof = async (attempt) => ({ attempt, ...terminal })
      await jobs.reconcile()
      expect((await ordinary.findOne(owner.jobId)).status).toBe(
        outcome === 'installed' ? JobStatus.COMPLETED : JobStatus.FAILED,
      )
      expect(await store.read(box.id, organizationId)).toMatchObject({
        state: outcome === 'installed' ? BoxState.STARTED : BoxState.ERROR,
        pending: false,
      })
    },
  )
})
