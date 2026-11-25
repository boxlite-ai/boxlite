// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { EntityManager } from 'typeorm'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationBoxLimitsService } from '../../organization/services/organization-box-limits.service'
import { ImageAdmissionService } from '../../image/services/image-admission.service'
import { upstreamRefOf } from '../../image/utils/image-ref.util'
import { Box } from '../entities/box.entity'
import { memoryGiBOf, memoryMibOf } from '../utils/memory-allocation'
import { BoxCheckpointState } from '../entities/box-checkpoint-state.entity'
import { Runner } from '../entities/runner.entity'
import { Checkpoint } from '../entities/checkpoint.entity'
import { CheckpointOperation } from '../entities/checkpoint-operation.entity'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { assertWithinPerBoxLimits } from './per-box-limits'
import { JobService } from './job.service'
import { CheckpointService } from './checkpoint.service'
import { BoxRepository } from '../repositories/box.repository'
import { GetRunnerParams, RunnerService } from './runner.service'
import { persistWithGeneratedBoxName } from '../utils/box-name-generator'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxCreatedEvent } from '../events/box-create.event'
import { CheckpointJobOwner, requireProtectedCheckpointOwner } from '../stores/protected-checkpoint.store'
import {
  CompleteOutboundSnapshot,
  RunnerOutboundControl,
  runnerOutboundEndpoint,
  sameCompleteOutboundSnapshot,
} from '../runner-adapter/outbound-control'

@Injectable()
export class CheckpointRecoverService {
  private readonly logger = new Logger(CheckpointRecoverService.name)

  constructor(
    private readonly checkpoints: CheckpointService,
    private readonly jobs: JobService,
    private readonly organizations: OrganizationService,
    private readonly limits: OrganizationBoxLimitsService,
    private readonly images: ImageAdmissionService,
    private readonly boxes: BoxRepository,
    private readonly runners: RunnerService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createBox(
    organization: Organization,
    checkpointKey: string,
    name: string | undefined,
    maxCreatedBoxes: number | undefined,
  ): Promise<Box> {
    if (name !== undefined && (!name || name.length > 128 || name.includes('\0')))
      throw new BadRequestException('Invalid box name')
    const selected = await this.admit(organization, checkpointKey)
    const box = new Box(selected.environment.region, name)
    const params: GetRunnerParams = {
      regions: [selected.environment.region],
      boxClass: selected.environment.class,
      requiresPrivileged: selected.environment.privileged,
    }
    const placement = selected.captureOutbound
      ? await this.prepareProtectedRestore(box.id, selected.captureOutbound, selected.environment, params)
      : null
    const runner = placement?.runner ?? (await this.runners.getRandomAvailableRunner(params))
    if (runner.apiVersion !== '2') throw new ConflictException('Checkpoint creation requires a v2 runner')
    Object.assign(box, selected.environment, {
      memoryMib: memoryMibOf(selected.environment),
      organizationId: organization.id,
      runnerId: runner.id,
      state: BoxState.RESTORING,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    const persist = async (candidate: string) => {
      box.name = candidate
      let checkpoint: Checkpoint
      let owner: CheckpointJobOwner | null = null
      return this.boxes.insert(
        box,
        maxCreatedBoxes,
        undefined,
        async (manager) => {
          if (selected.captureOutbound) owner = await requireProtectedCheckpointOwner(manager, runner.id)
          const currentCheckpoint = await manager.findOne(Checkpoint, {
            where: { id: selected.id, organizationId: organization.id },
            lock: { mode: 'pessimistic_write' },
          })
          if (!currentCheckpoint || currentCheckpoint.state !== 'ready' || !currentCheckpoint.archive)
            throw new ConflictException('Checkpoint is not ready')
          if (
            Boolean(currentCheckpoint.captureOutbound) !== Boolean(owner) ||
            (currentCheckpoint.captureOutbound &&
              selected.captureOutbound &&
              !sameCompleteOutboundSnapshot(currentCheckpoint.captureOutbound, selected.captureOutbound))
          )
            throw new ConflictException('Checkpoint policy changed during restore admission')
          checkpoint = currentCheckpoint
          const currentRunner = await manager.findOne(Runner, {
            where: { id: runner.id },
            lock: { mode: 'pessimistic_read' },
          })
          if (!this.runnerAccepts(currentRunner, checkpoint.environment))
            throw new ConflictException('Target runner cannot accept the checkpoint configuration')
          if (
            placement &&
            (currentRunner.apiKey !== runner.apiKey ||
              runnerOutboundEndpoint(currentRunner) !== runnerOutboundEndpoint(runner) ||
              !isDeepStrictEqual(owner, placement.owner))
          )
            throw new ConflictException('Runner identity changed during checkpoint admission')
        },
        async (manager) => {
          await this.schedule(
            manager,
            checkpoint,
            box,
            manager.create(BoxCheckpointState, { boxId: box.id }),
            owner,
            placement?.snapshot,
          )
          await manager.save(Box, box)
        },
      )
    }
    try {
      const created = name === undefined ? await persistWithGeneratedBoxName(box.id, persist) : await persist(name)
      this.eventEmitter
        .emitAsync(BoxEvents.CREATED, new BoxCreatedEvent(created))
        .catch((error) => this.logger.error('Failed to emit BoxCreatedEvent', error))
      return created
    } catch (error) {
      if (error?.code === '23505') throw new ConflictException('Box name already exists')
      throw error
    }
  }

  private async prepareProtectedRestore(
    boxId: string,
    captured: CompleteOutboundSnapshot,
    environment: Checkpoint['environment'],
    params: GetRunnerParams,
  ) {
    const available = await this.runners.findAvailableRunners({ ...params, protectedCheckpoint: true })
    const candidates = available.filter((runner) => this.runnerAccepts(runner, environment))
    // Only nonempty installed deny rules require a deny-capable backend.
    const policy = {
      ...captured.policy,
      deny_net: captured.policy.deny_net.length ? captured.policy.deny_net : undefined,
    }
    const requiresIpv6 = captured.admission === 'extended_dual_stack'
    const batchSize = 10
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize)
      const prepared = await Promise.all(
        batch.map(async (runner) => {
          try {
            const owner = await this.runners.getProtectedCheckpointOwner(runner.id)
            const { snapshot } = await new RunnerOutboundControl(runner, boxId).prepareCreate(randomUUID(), policy)
            if (requiresIpv6 && !snapshot.ipv6) return
            const target = {
              ...snapshot,
              admission: captured.admission,
              ipv6: requiresIpv6 ? snapshot.ipv6 : undefined,
            }
            if (sameCompleteOutboundSnapshot({ ...captured, revision: target.revision, ipv6: target.ipv6 }, target))
              return { runner, owner, snapshot: target }
          } catch (error) {
            if (!(error instanceof HttpException)) throw error
            this.logger.debug(`Runner ${runner.id} declined checkpoint preparation: ${error.getStatus()}`)
          }
        }),
      )
      const placement = prepared.find((candidate) => candidate !== undefined)
      if (placement) return placement
    }
    throw new ServiceUnavailableException('No enrolled Runner can restore the checkpoint outbound policy')
  }

  private async admit(organization: Organization, key: string): Promise<Checkpoint> {
    this.checkpoints.assertEnabled()
    this.organizations.assertOrganizationIsNotSuspended(organization)
    const checkpoint = await this.checkpoints.get(organization.id, key)
    if (checkpoint.state !== 'ready' || !checkpoint.archive) throw new ConflictException('Checkpoint is not ready')
    if (!checkpoint.environment.image) throw new BadRequestException('Checkpoint has no OCI image')
    const limits = await this.limits.resolve(organization)
    assertWithinPerBoxLimits(
      checkpoint.environment.cpu,
      memoryGiBOf(checkpoint.environment),
      checkpoint.environment.disk,
      limits,
    )
    await this.images.assert(organization, upstreamRefOf(checkpoint.environment.image))
    return checkpoint
  }

  private runnerAccepts(runner: Runner | null, env: Checkpoint['environment']): runner is Runner {
    return (
      runner !== null &&
      runner.state === RunnerState.READY &&
      runner.apiVersion === '2' &&
      !runner.draining &&
      !runner.unschedulable &&
      runner.region === env.region &&
      runner.class === env.class &&
      (!env.privileged || runner.supportsPrivileged) &&
      env.cpu <= runner.cpu &&
      memoryGiBOf(env) <= runner.memoryGiB &&
      env.disk <= runner.diskGiB &&
      (env.gpu ?? 0) <= (runner.gpu ?? 0)
    )
  }

  private async schedule(
    manager: EntityManager,
    checkpoint: Checkpoint,
    box: Box,
    checkpointState: BoxCheckpointState,
    owner: CheckpointJobOwner | null,
    targetOutbound: CompleteOutboundSnapshot | undefined,
  ): Promise<void> {
    if (checkpoint.captureOutbound && (!owner || !targetOutbound))
      throw new ConflictException('Protected checkpoint requires a prepared target and Runner lease')
    const operation = manager.create(CheckpointOperation, {
      id: randomUUID(),
      organizationId: box.organizationId,
      checkpointId: checkpoint.id,
      boxId: box.id,
      runnerId: box.runnerId,
      sequence: checkpointState.sequence + 1,
      mode: 'create',
      environment: checkpoint.environment,
      platformEnv: {
        BOXLITE_BOX_ID: box.id,
        BOXLITE_ORGANIZATION_ID: box.organizationId,
        BOXLITE_REGION_ID: box.region,
      },
      nativeId: null,
    })
    const restore = {
      operationId: operation.id,
      targetSequence: operation.sequence,
      targetBoxId: box.id,
      mode: operation.mode,
      platformEnv: operation.platformEnv,
    }
    const job =
      checkpoint.captureOutbound && owner && targetOutbound
        ? await this.jobs.createJob(
            manager,
            JobType.IMPORT_PROTECTED_CHECKPOINT,
            box.runnerId!,
            ResourceType.BOX,
            box.id,
            {
              ...owner,
              checkpointId: checkpoint.id,
              arcPath: checkpoint.arcPath,
              captureOutbound: checkpoint.captureOutbound,
              archive: checkpoint.archive,
              restore: { ...restore, targetOutbound },
            },
          )
        : await this.jobs.createJob(manager, JobType.IMPORT_CHECKPOINT, box.runnerId!, ResourceType.BOX, box.id, {
            ...restore,
            archive: checkpoint.archive,
          })
    Object.assign(operation, { jobId: job.id, state: 'pending', errorReason: null })
    await manager.save(CheckpointOperation, operation)
    Object.assign(checkpointState, { activeJobId: job.id, sequence: operation.sequence })
    await manager.save(BoxCheckpointState, checkpointState)
    Object.assign(box, {
      state: BoxState.RESTORING,
      pending: true,
      errorReason: null,
    })
  }
}
