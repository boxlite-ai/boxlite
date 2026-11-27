import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { createHash } from 'node:crypto'
import { DataSource, EntityManager } from 'typeorm'
import type { RunnerContext } from '../../common/interfaces/runner-context.interface'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { Runner } from '../entities/runner.entity'
import { CompleteCreateIntent, createAttempt } from '../entities/outbound-control-record'
import { JobStatus, JobType, ResourceType } from '../dto/job.dto'
import { BoxRepository } from '../repositories/box.repository'
import {
  CompleteCreateAttempt,
  CompleteCreateBox,
  CompleteCreateOutcome,
  decodeCompleteCreateOutcome,
  RunnerOutboundControl,
  validCompleteCreateAttempt,
} from '../runner-adapter/outbound-control'
import { outboundCreateBoxRequest } from '../runner-adapter/outbound-create-box'
import { BoxStartAction } from '../managers/box-actions/box-start.action'
import { completeOutboundRecord, lockCompleteRunner } from '../stores/outbound-policy.store'
import { JobService } from './job.service'

const COMPLETE_CREATE = JobType.CREATE_COMPLETE_OUTBOUND_BOX
const CLAIM_LIFETIME_MS = 10 * 60_000
const UUID_PATTERN = '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'

type Payload = {
  lease_id: string
  request: { attempt: CompleteCreateAttempt; box: CompleteCreateBox }
}
type Worker = { runnerId: string; apiKey: string; tokenHash: string }
type TerminalOutcome = Exclude<CompleteCreateOutcome, { outcome: 'pending' }>

@Injectable()
export class CompleteCreateJobService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CompleteCreateJobService.name)

  constructor(
    private readonly dataSource: DataSource,
    private readonly boxes: BoxRepository,
    private readonly jobs: JobService,
    private readonly startAction: BoxStartAction,
  ) {}

  onApplicationBootstrap() {
    void this.reconcile().catch(() => this.logger.warn('Could not reconcile complete V2 creates at startup'))
  }

  async prepareBox(box: Box, runner: Runner): Promise<CompleteCreateBox> {
    const { image, metadata, nested } = await this.startAction.createConfiguration(box, runner)
    return outboundCreateBoxRequest(runner, box, image, metadata, nested)
  }

  async enqueue(
    manager: EntityManager,
    owner: Extract<CompleteCreateIntent, { transport: 'v2' }>,
    box: CompleteCreateBox,
  ) {
    const lease = await this.lease(manager, owner.runnerId)
    if (!lease) throw new ServiceUnavailableException('Runner has no current complete outbound enrollment')
    const payload: Payload = { lease_id: lease, request: { attempt: createAttempt(owner), box } }
    await this.jobs.createJob(manager, COMPLETE_CREATE, owner.runnerId, ResourceType.BOX, box.id, payload, owner.jobId)
  }

  async claim(context: RunnerContext, token: string | undefined): Promise<Payload['request'] | null> {
    const worker = this.worker(context, token)
    return this.dataSource.transaction(async (manager) => {
      const lease = await this.lease(manager, worker.runnerId, worker, false, true)
      if (!lease) throw new ForbiddenException('Runner has no matching complete outbound lease')
      const job = await manager
        .createQueryBuilder(Job, 'job')
        .where('job.type = :type AND job.runnerId = :runnerId AND job.status = :status', {
          type: COMPLETE_CREATE,
          runnerId: worker.runnerId,
          status: JobStatus.PENDING,
        })
        .andWhere(`CASE WHEN job.type = :type THEN CAST(job.payload AS jsonb) ->> 'lease_id' END = :lease`, { lease })
        .orderBy('job.createdAt', 'ASC')
        .addOrderBy('job.id', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .limit(1)
        .getOne()
      if (!job) return null
      const payload = this.payload(job)
      if (!(await this.owner(manager, job, payload))) return null
      await manager.update(Job, job.id, { status: JobStatus.IN_PROGRESS, startedAt: new Date() })
      return payload.request
    })
  }

  async accept(context: RunnerContext, token: string | undefined, jobId: string, proof: unknown) {
    const worker = this.worker(context, token)
    await this.dataSource.transaction(async (manager) => {
      const lease = await this.lease(manager, worker.runnerId, worker)
      if (!lease) throw new ForbiddenException('Runner has no matching complete outbound lease')
      const job = await this.lockJob(manager, jobId, worker.runnerId)
      const payload = this.payload(job)
      if (payload.lease_id !== lease) throw new ForbiddenException('The job belongs to a different Runner lease')
      const result = decodeCompleteCreateOutcome(proof, payload.request.attempt)
      if (result.outcome === 'pending') throw new ConflictException('Complete create has no terminal evidence')
      if (job.completedAt) {
        this.assertTerminalReplay(job, payload, result)
        return
      }
      if (job.completeOutboundReconciling || this.expired(job) || !(await this.owner(manager, job, payload))) {
        throw new ConflictException('Complete create claim is not active')
      }
      await this.writeTerminal(manager, job, payload, result)
    })
    await this.publish(jobId)
  }

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'reconcile-complete-v2-creates', waitForCompletion: true })
  async reconcile(): Promise<void> {
    let after = ''
    for (;;) {
      const primary = this.dataSource.createQueryRunner('master')
      let rows: { boxId: string; jobId: string }[]
      try {
        const jobId = `box.completeOutboundControl #>> '{pending,jobId}'`
        rows = await primary.manager
          .createQueryBuilder(Box, 'box')
          .select('box.id', 'boxId')
          .addSelect('job.id', 'jobId')
          .innerJoin(
            Job,
            'job',
            `job.id = CAST(CASE WHEN ${jobId} ~* :uuid THEN ${jobId} END AS uuid) AND job.resourceId = box.id`,
            { uuid: UUID_PATTERN },
          )
          .where(`box.pending AND box.completeOutboundControl #>> '{pending,transport}' = 'v2' AND box.id > :after`, {
            after,
          })
          .andWhere('job.type = :type', { type: COMPLETE_CREATE })
          .andWhere(
            `(job.completedAt IS NOT NULL OR job.startedAt <= :expired OR
            (job.status = :pending AND NOT EXISTS (
              SELECT 1 FROM complete_outbound_runner_enrollment e
              JOIN "runner" r ON r.id = e.runner_id
              WHERE e.runner_id = box."runnerId" AND e.expires_at > clock_timestamp()
                AND r."apiVersion" = '2'
                AND e.runner_key_sha256 = encode(sha256(convert_to(r."apiKey", 'UTF8')), 'hex')
                AND CAST(e.lease_id AS text) = CASE WHEN job.type = :type THEN CAST(job.payload AS jsonb) ->> 'lease_id' END
            )))`,
            {
              expired: new Date(Date.now() - CLAIM_LIFETIME_MS),
              pending: JobStatus.PENDING,
            },
          )
          .orderBy('box.id')
          .limit(100)
          .getRawMany<{ boxId: string; jobId: string }>()
      } finally {
        await primary.release()
      }
      if (!rows.length) return
      for (let index = 0; index < rows.length; index += 10) {
        await Promise.all(
          rows
            .slice(index, index + 10)
            .map(({ jobId }) =>
              this.reconcileJob(jobId).catch(() =>
                this.logger.debug(`Complete create job ${jobId} still needs reconciliation`),
              ),
            ),
        )
      }
      after = rows[rows.length - 1].boxId
    }
  }

  async reconcileJob(jobId: string): Promise<void> {
    const { job, runner } = await this.dataSource.transaction(async (manager) => {
      const candidate = await manager.findOneBy(Job, { id: jobId, type: COMPLETE_CREATE })
      if (!candidate) throw new ConflictException('Complete create job is unavailable')
      await lockCompleteRunner(manager, candidate.runnerId)
      const locked = await this.lockJob(manager, jobId, candidate.runnerId)
      if (locked.completedAt || (locked.status !== JobStatus.PENDING && !this.expired(locked))) {
        return { job: locked }
      }
      const payload = this.payload(locked)
      if (!(await this.owner(manager, locked, payload))) return { job: locked }
      if (locked.status === JobStatus.PENDING) {
        // A claim is delivered only after its IN_PROGRESS transaction commits.
        // The lock proves this job has never been handed to a worker.
        if (locked.startedAt || payload.lease_id === (await this.lease(manager, locked.runnerId)))
          return { job: locked }
        const completedAt = new Date()
        await manager.update(Job, locked.id, {
          status: JobStatus.FAILED,
          completedAt,
          resultMetadata: JSON.stringify({ attempt: payload.request.attempt, outcome: 'no_effect' }),
        })
        locked.completedAt = completedAt
        return { job: locked }
      }
      if (!locked.completeOutboundReconciling) {
        await manager.update(Job, locked.id, { completeOutboundReconciling: true })
      }
      if (payload.lease_id !== (await this.lease(manager, locked.runnerId, undefined, true))) return { job: locked }
      const runner = await manager.findOneBy(Runner, { id: locked.runnerId })
      return { job: locked, runner }
    })
    if (job.completedAt) return this.publish(jobId)
    if (!runner) return
    const payload = this.payload(job)
    const result = await new RunnerOutboundControl(runner, job.resourceId).cancelCompleteCreate(payload.request.attempt)
    if (result.outcome === 'pending') return
    await this.dataSource.transaction(async (manager) => {
      const lease = await this.lease(manager, job.runnerId, undefined, true)
      const locked = await this.lockJob(manager, jobId)
      if (
        locked.completedAt ||
        !locked.completeOutboundReconciling ||
        lease !== payload.lease_id ||
        locked.payload !== job.payload ||
        !(await this.owner(manager, locked, payload))
      )
        return
      await this.writeTerminal(manager, locked, payload, result)
    })
    await this.publish(jobId)
  }

  private async publish(jobId: string) {
    const proof = await this.dataSource.transaction(async (manager) => {
      const job = await manager.findOneBy(Job, { id: jobId, type: COMPLETE_CREATE })
      if (!job?.completedAt || !job.resultMetadata) return null
      const payload = this.payload(job)
      const target = await this.owner(manager, job, payload)
      if (!target) return null
      return { ...target, result: decodeCompleteCreateOutcome(JSON.parse(job.resultMetadata), payload.request.attempt) }
    })
    if (proof) await this.boxes.settleCompleteCreate(proof.box, proof.reservation, proof.result)
  }

  private worker(context: RunnerContext, token: string | undefined): Worker {
    if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token))
      throw new ForbiddenException('Complete outbound lease is required')
    return {
      runnerId: context.runnerId,
      apiKey: context.runner.apiKey,
      tokenHash: createHash('sha256').update(token).digest('hex'),
    }
  }

  private async lease(
    manager: EntityManager,
    runnerId: string,
    worker?: Worker,
    allowExpired = false,
    forClaim = false,
  ): Promise<string | null> {
    await lockCompleteRunner(manager, runnerId)
    const [enrolled] = await manager.query(
      `SELECT enrollment.lease_id
      FROM complete_outbound_runner_enrollment AS enrollment
      JOIN "runner" AS runner ON runner.id = enrollment.runner_id
      WHERE runner.id = $1 AND runner."apiVersion" = '2'
        AND enrollment.runner_key_sha256 = encode(sha256(convert_to(runner."apiKey", 'UTF8')), 'hex')
        ${allowExpired ? '' : 'AND enrollment.expires_at > clock_timestamp()'}
        ${forClaim ? "AND runner.state = 'ready' AND NOT runner.unschedulable AND NOT runner.draining" : ''}
        ${worker ? 'AND enrollment.token_sha256 = $2 AND runner."apiKey" = $3' : ''}
      FOR SHARE OF enrollment`,
      [runnerId, ...(worker ? [worker.tokenHash, worker.apiKey] : [])],
    )
    return enrolled?.lease_id ?? null
  }

  private async lockJob(manager: EntityManager, id: string, runnerId?: string): Promise<Job> {
    const job = await manager
      .createQueryBuilder(Job, 'job')
      .addSelect('job.completeOutboundReconciling')
      .where({ id, type: COMPLETE_CREATE, ...(runnerId ? { runnerId } : {}) })
      .setLock('pessimistic_write')
      .getOne()
    if (!job) throw new ConflictException('Complete create job is unavailable')
    return job
  }

  private payload(job: Job): Payload {
    const payload = job.getPayload<Payload>()
    if (
      job.resourceType !== ResourceType.BOX ||
      !validCompleteCreateAttempt(payload?.request?.attempt) ||
      payload.request.attempt.job_id !== job.id ||
      !payload.request.attempt.claim_id ||
      payload.request.box?.id !== job.resourceId ||
      !payload.lease_id
    ) {
      throw new ConflictException('Complete create job payload is invalid')
    }
    return payload
  }

  private async owner(manager: EntityManager, job: Job, payload: Payload) {
    const box = await manager
      .createQueryBuilder(Box, 'box')
      .addSelect('box.completeOutboundControl')
      .where({ id: job.resourceId, runnerId: job.runnerId, pending: true })
      .getOne()
    const reservation = box && completeOutboundRecord(box)
    const owner = reservation?.pending
    if (
      owner?.kind !== 'create' ||
      owner.transport !== 'v2' ||
      owner.runnerId !== job.runnerId ||
      owner.jobId !== job.id
    ) {
      return null
    }
    decodeCompleteCreateOutcome({ attempt: payload.request.attempt, outcome: 'pending' }, createAttempt(owner))
    return { box, reservation }
  }

  private expired(job: Job): boolean {
    return (
      job.status === JobStatus.IN_PROGRESS &&
      !!job.startedAt &&
      Date.now() - job.startedAt.getTime() >= CLAIM_LIFETIME_MS
    )
  }

  private async writeTerminal(manager: EntityManager, job: Job, payload: Payload, result: TerminalOutcome) {
    if (job.status !== JobStatus.IN_PROGRESS || job.completedAt) {
      throw new ConflictException('Complete create cannot be completed without its claim')
    }
    await manager.update(Job, job.id, {
      status: result.outcome === 'installed' ? JobStatus.COMPLETED : JobStatus.FAILED,
      completedAt: new Date(),
      resultMetadata: JSON.stringify({ attempt: payload.request.attempt, ...result }),
    })
  }

  private assertTerminalReplay(job: Job, payload: Payload, result: TerminalOutcome) {
    const current = decodeCompleteCreateOutcome(JSON.parse(job.resultMetadata ?? 'null'), payload.request.attempt)
    if (
      current.outcome !== result.outcome ||
      (current.outcome === 'no_effect' && result.outcome === 'no_effect' && current.failure !== result.failure)
    ) {
      throw new ConflictException('Complete create terminal receipt is immutable')
    }
  }
}
