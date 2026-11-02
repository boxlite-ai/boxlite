import {
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
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
import {
  BoxResources,
  RESIZE_MAX_DURATION_MINUTES,
  ResizePayload,
  resizeTarget,
  validResources,
} from '../box/services/resize-resources'
import { Organization } from '../organization/entities/organization.entity'
import { OrganizationService } from '../organization/services/organization.service'
import { UsageService } from '../usage/services/usage.service'
import { TypedConfigService } from '../config/typed-config.service'
import { ResizeBoxDto } from './dto/resize-box.dto'
import { BoxLookupCacheInvalidationService } from '../box/services/box-lookup-cache-invalidation.service'

@Injectable()
export class BoxResizeService {
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
    const targetMemoryGiB = Math.ceil(target.memory_mib / 1024)
    assertWithinPerBoxLimits(target.cpus, targetMemoryGiB, box.disk, organization)

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
        if (
          target.cpus === current.cpus &&
          target.memory_mib === current.memory_mib &&
          locked.cpu === target.cpus &&
          locked.mem === targetMemoryGiB
        )
          return null
        if (target.cpus < locked.cpu || targetMemoryGiB < locked.mem)
          throw new ConflictException('Resize cannot shrink the committed Box size')
        const existing = await manager.findOneBy(Job, {
          resourceId: box.id,
          resourceType: ResourceType.BOX,
          completedAt: IsNull(),
        })
        if (existing) throw new ConflictException('Box has unfinished lifecycle work')
        const [{ now, deadline }] = await manager.query(
          `SELECT statement_timestamp() AS now,
                  statement_timestamp() + ($1::int * interval '1 minute') AS deadline`,
          [RESIZE_MAX_DURATION_MINUTES],
        )
        const payload: ResizePayload = {
          version: 1,
          ...target,
          previous: { cpus: locked.cpu, memory_mib: locked.mem * 1024 },
        }
        const created = new Job({
          type: JobType.RESIZE_BOX,
          runnerId: locked.runnerId,
          resourceType: ResourceType.BOX,
          resourceId: locked.id,
          payload: JSON.stringify(payload),
        })
        created.resizePhase = 'APPLY'
        created.nextAttemptAt = new Date(now)
        created.resizeDeadlineAt = new Date(deadline)
        await manager.insert(Job, created)
        await manager.update(Box, locked.id, {
          pending: true,
          resizeJobId: created.id,
        })
        signal.throwIfAborted()
        return created
      }),
    )

    if (!job) return current
    this.cache.invalidate({ id: box.id, organizationId: box.organizationId, name: box.name })
    try {
      await this.jobs.notifyRunner(job.runnerId, job.id)
    } catch {
      this.logger.warn({ message: 'Resize notification lost; database polling will recover', jobId: job.id })
    }
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
      if (current.status === JobStatus.FAILED && current.completedAt) {
        throw new ConflictException(current.errorMessage || 'Resize failed; the Box is unchanged')
      }
      await sleep(250)
    }
    throw new GatewayTimeoutException({
      code: 'resize_in_progress',
      message:
        'Configuration accepted; resize continues in the background. Box size and billing update only after the Runner confirms completion. Retry the same target or query resources.',
    })
  }
}
