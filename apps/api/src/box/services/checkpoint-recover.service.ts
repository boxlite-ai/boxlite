// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { randomUUID } from 'node:crypto'
import { EntityManager } from 'typeorm'
import { Organization } from '../../organization/entities/organization.entity'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationBoxLimitsService } from '../../organization/services/organization-box-limits.service'
import { ImageAdmissionService } from '../../image/services/image-admission.service'
import { upstreamRefOf } from '../../image/utils/image-ref.util'
import { Box } from '../entities/box.entity'
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
import { RunnerService } from './runner.service'
import { persistWithGeneratedBoxName } from '../utils/box-name-generator'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxCreatedEvent } from '../events/box-create.event'

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
    const runner = await this.runners.getRandomAvailableRunner({
      regions: [selected.environment.region],
      boxClass: selected.environment.class,
      requiresPrivileged: selected.environment.privileged,
    })
    if (runner.apiVersion !== '2') throw new ConflictException('Checkpoint creation requires a v2 runner')
    const box = Object.assign(new Box(selected.environment.region, name), selected.environment, {
      organizationId: organization.id,
      runnerId: runner.id,
      state: BoxState.RESTORING,
      desiredState: BoxDesiredState.STARTED,
      pending: true,
    })
    const persist = async (candidate: string) => {
      box.name = candidate
      let checkpoint: Checkpoint
      return this.boxes.insert(
        box,
        maxCreatedBoxes,
        undefined,
        async (manager) => {
          const currentCheckpoint = await manager.findOne(Checkpoint, {
            where: { id: selected.id, organizationId: organization.id },
            lock: { mode: 'pessimistic_write' },
          })
          if (!currentCheckpoint || currentCheckpoint.state !== 'ready' || !currentCheckpoint.archive)
            throw new ConflictException('Checkpoint is not ready')
          checkpoint = currentCheckpoint
          const currentRunner = await manager.findOne(Runner, {
            where: { id: runner.id },
            lock: { mode: 'pessimistic_read' },
          })
          this.assertRunner(currentRunner, checkpoint)
        },
        async (manager) => {
          await this.schedule(manager, checkpoint, box, manager.create(BoxCheckpointState, { boxId: box.id }))
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

  private async admit(organization: Organization, key: string): Promise<Checkpoint> {
    this.checkpoints.assertEnabled()
    this.organizations.assertOrganizationIsNotSuspended(organization)
    const checkpoint = await this.checkpoints.get(organization.id, key)
    if (checkpoint.state !== 'ready' || !checkpoint.archive) throw new ConflictException('Checkpoint is not ready')
    if (!checkpoint.environment.image) throw new BadRequestException('Checkpoint has no OCI image')
    const limits = await this.limits.resolve(organization)
    assertWithinPerBoxLimits(
      checkpoint.environment.cpu,
      checkpoint.environment.mem,
      checkpoint.environment.disk,
      limits,
    )
    await this.images.assert(organization, upstreamRefOf(checkpoint.environment.image))
    return checkpoint
  }

  private assertRunner(runner: Runner | null, checkpoint: Checkpoint): asserts runner is Runner {
    const env = checkpoint.environment
    if (
      !runner ||
      runner.state !== RunnerState.READY ||
      runner.apiVersion !== '2' ||
      runner.draining ||
      runner.unschedulable ||
      runner.region !== env.region ||
      runner.class !== env.class ||
      (env.privileged && !runner.supportsPrivileged) ||
      env.cpu > runner.cpu ||
      env.mem > runner.memoryGiB ||
      env.disk > runner.diskGiB ||
      env.gpu > (runner.gpu ?? 0)
    )
      throw new ConflictException('Target runner cannot accept the checkpoint configuration')
  }

  private async schedule(
    manager: EntityManager,
    checkpoint: Checkpoint,
    box: Box,
    checkpointState: BoxCheckpointState,
  ): Promise<void> {
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
    const job = await this.jobs.createJob(manager, JobType.IMPORT_CHECKPOINT, box.runnerId!, ResourceType.BOX, box.id, {
      operationId: operation.id,
      targetSequence: operation.sequence,
      targetBoxId: box.id,
      mode: operation.mode,
      archive: checkpoint.archive,
      platformEnv: operation.platformEnv,
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
