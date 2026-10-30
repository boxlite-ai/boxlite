import {
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { DataSource, IsNull } from 'typeorm'
import { setTimeout as sleep } from 'node:timers/promises'
import { Box } from '../box/entities/box.entity'
import { Job } from '../box/entities/job.entity'
import { JobStatus, JobType, ResourceType } from '../box/dto/job.dto'
import { BoxState } from '../box/enums/box-state.enum'
import { BoxDesiredState } from '../box/enums/box-desired-state.enum'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { JobService } from '../box/services/job.service'
import { assertWithinPerBoxLimits } from '../box/services/per-box-limits'
import { BoxResources, ResizePayload, resizeTarget, validResources } from '../box/services/resize-resources'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationService } from '../organization/services/organization.service'
import { UsageService } from '../usage/services/usage.service'
import { TypedConfigService } from '../config/typed-config.service'
import { ResizeBoxDto } from './dto/resize-box.dto'
import { BoxLookupCacheInvalidationService } from '../box/services/box-lookup-cache-invalidation.service'

@Injectable()
export class BoxResizeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BoxResizeService.name)

  constructor(
    private readonly db: DataSource,
    private readonly boxes: BoxService,
    private readonly runners: RunnerService,
    private readonly usage: UsageService,
    private readonly organizations: OrganizationService,
    private readonly config: TypedConfigService,
    private readonly jobs: JobService,
    private readonly cache: BoxLookupCacheInvalidationService,
  ) {}

  async resize(id: string, organization: Organization, request: ResizeBoxDto): Promise<BoxResources> {
    const identity = await this.boxes.findOneByIdOrName(id, organization.id)
    const box = await this.db.getRepository(Box).findOneByOrFail({ id: identity.id, organizationId: organization.id })
    if (request.cpus === undefined && request.memory_mib === undefined) return this.observe(box)
    this.organizations.assertOrganizationIsNotSuspended(organization)
    if (box.resizeJobId) return this.waitFor(await this.sameRequest(box.resizeJobId, request))
    if (!this.config.get('cloudResizeEnabled'))
      throw new ServiceUnavailableException('Cloud resize admission is disabled')
    this.assertRunning(box)
    const current = await this.observe(box)
    const target = resizeTarget(request, current)
    assertWithinPerBoxLimits(target.cpus, Math.ceil(target.memory_mib / 1024), box.disk, organization)
    if (target.cpus === current.cpus && target.memory_mib === current.memory_mib) return current

    const job = await this.usage.withResourceLock(box.id, async (signal) =>
      this.db.transaction(async (manager) => {
        const locked = await manager.findOneOrFail(Box, {
          where: { id: box.id, organizationId: organization.id },
          lock: { mode: 'pessimistic_write' },
          loadEagerRelations: false,
        })
        if (locked.resizeJobId) return this.sameRequest(locked.resizeJobId, request)
        this.assertRunning(locked)
        if (locked.pending || locked.runnerId !== box.runnerId || locked.cpu !== box.cpu || locked.mem !== box.mem)
          throw new ConflictException('Box changed; retry resize')
        const existing = await manager.findOneBy(Job, {
          resourceId: box.id,
          resourceType: ResourceType.BOX,
          completedAt: IsNull(),
        })
        if (existing) throw new ConflictException('Box has unfinished lifecycle work')
        const payload: ResizePayload = {
          version: 1,
          ...target,
          previous: { cpus: current.cpus, memory_mib: current.memory_mib },
        }
        const created = new Job({
          type: JobType.RESIZE_BOX,
          runnerId: locked.runnerId,
          resourceType: ResourceType.BOX,
          resourceId: locked.id,
          payload: JSON.stringify(payload),
        })
        created.resizePhase = 'BILLING_PENDING'
        await manager.insert(Job, created)
        await manager.update(Box, locked.id, {
          cpu: target.cpus,
          mem: Math.ceil(target.memory_mib / 1024),
          pending: true,
          resizeJobId: created.id,
        })
        signal.throwIfAborted()
        return created
      }),
    )
    this.cache.invalidate({ id: box.id, organizationId: box.organizationId, name: box.name })
    await this.activate(job)
    return this.waitFor(job)
  }

  private assertRunning(box: Box): void {
    if (box.state !== BoxState.STARTED || box.desiredState !== BoxDesiredState.STARTED || !box.runnerId) {
      throw new ConflictException('Online resize requires a running box')
    }
  }

  private async observe(box: Box): Promise<BoxResources> {
    this.assertRunning(box)
    const runner = await this.runners.findOne(box.runnerId)
    if (!runner || runner.apiVersion !== '2')
      throw new ServiceUnavailableException('Runner does not support resize jobs')
    const endpoint = runner.apiUrl || runner.proxyUrl
    if (!endpoint) throw new ServiceUnavailableException('Runner endpoint unavailable')
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, '')}/v1/boxes/${encodeURIComponent(box.id)}/resources`, {
        headers: { Authorization: `Bearer ${runner.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error('Runner resource query failed')
      const body = await response.json()
      if (body.resize_jobs_v1 !== true || !validResources(body.resources))
        throw new Error('Unsupported resource response')
      return body.resources
    } catch {
      throw new ServiceUnavailableException('Cannot query resize-capable Runner resources')
    }
  }

  private async sameRequest(jobId: string, request: ResizeBoxDto): Promise<Job> {
    const job = await this.db.getRepository(Job).findOneByOrFail({ id: jobId })
    const target = job.getPayload<ResizePayload>()
    if (
      !target ||
      target.version !== 1 ||
      (request.cpus !== undefined && request.cpus !== target.cpus) ||
      (request.memory_mib !== undefined && Math.ceil(request.memory_mib / 1024) * 1024 !== target.memory_mib)
    ) {
      throw new ConflictException('A different resize target is already pending')
    }
    return job
  }

  private async waitFor(job: Job): Promise<BoxResources> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const current = await this.db.getRepository(Job).findOneByOrFail({ id: job.id })
      if (current.status === JobStatus.COMPLETED) {
        const result = current.getResultMetadata()
        if (validResources(result)) return result
        throw new ConflictException('Resize completion has no valid resources')
      }
      await sleep(250)
    }
    throw new GatewayTimeoutException({
      code: 'resize_in_progress',
      message:
        'Configuration accepted; billing transition and resize continue in the background. Retry the same target or query resources.',
    })
  }

  private async activate(job: Job): Promise<void> {
    try {
      await this.usage.activateResizeJob(job.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.error({ message: 'Resize billing will retry', jobId: job.id, boxId: job.resourceId, error: message })
      try {
        await this.db
          .getRepository(Job)
          .createQueryBuilder()
          .update(Job)
          .set({ errorMessage: message, nextAttemptAt: () => "statement_timestamp() + interval '15 seconds'" })
          .where('id = :id AND "resizePhase" = :phase', { id: job.id, phase: 'BILLING_PENDING' })
          .execute()
      } catch (retryError) {
        this.logger.error('Could not record billing retry; persisted job remains recoverable', retryError)
      }
      return
    }
    // Notification is only a hint; the committed job remains pollable if Redis fails.
    try {
      await this.jobs.notifyRunner(job.runnerId, job.id)
    } catch {
      this.logger.warn({ message: 'Resize notification lost; database polling will recover', jobId: job.id })
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverBilling()
  }

  @Cron('*/15 * * * * *', { name: 'recover-resize-billing' })
  async recoverBilling(): Promise<void> {
    try {
      const pending = await this.db
        .getRepository(Job)
        .createQueryBuilder('job')
        .where('job.type = :type AND job.status = :status AND job.resizePhase = :phase', {
          type: JobType.RESIZE_BOX,
          status: JobStatus.PENDING,
          phase: 'BILLING_PENDING',
        })
        .andWhere('(job.nextAttemptAt IS NULL OR job.nextAttemptAt <= statement_timestamp())')
        .orderBy('job.updatedAt', 'ASC')
        .take(100)
        .getMany()
      for (const job of pending) await this.activate(job)
    } catch (error) {
      this.logger.error('Cannot scan pending resize billing', error)
    }
  }
}
