// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource, EntityManager, In, IsNull, Not } from 'typeorm'
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
import { Job } from '../entities/job.entity'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { assertWithinPerBoxLimits } from './per-box-limits'
import { JobService } from './job.service'
import { CheckpointService } from './checkpoint.service'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { BoxRepository } from '../repositories/box.repository'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { RunnerService } from './runner.service'
import { persistWithGeneratedBoxName } from '../utils/box-name-generator'

@Injectable()
export class CheckpointRecoverService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly checkpoints: CheckpointService,
    private readonly jobs: JobService,
    private readonly organizations: OrganizationService,
    private readonly limits: OrganizationBoxLimitsService,
    private readonly images: ImageAdmissionService,
    private readonly cache: BoxLookupCacheInvalidationService,
    private readonly boxes: BoxRepository,
    private readonly runners: RunnerService,
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
          await this.schedule(manager, checkpoint, box, 'create', manager.create(BoxCheckpointState, { boxId: box.id }))
          await manager.save(Box, box)
        },
      )
    }
    try {
      return name === undefined ? await persistWithGeneratedBoxName(box.id, persist) : await persist(name)
    } catch (error) {
      if (error?.code === '23505') throw new ConflictException('Box name already exists')
      throw error
    }
  }

  async recover(
    organization: Organization,
    checkpointKey: string,
    target: string,
    maxCreatedBoxes: number | undefined,
  ): Promise<Box> {
    const selected = await this.admit(organization, checkpointKey)
    const selectedTarget = await this.dataSource.getRepository(Box).findOne({
      where: [
        { id: target, organizationId: organization.id },
        { name: target, organizationId: organization.id },
      ],
    })
    if (!selectedTarget) throw new NotFoundException('Recovery target not found')
    const box = await this.boxes.withCheckpointRestoreAdmission(
      organization.id,
      selectedTarget.id,
      maxCreatedBoxes,
      async (manager) => {
        // A use and deletion lock the same checkpoint first, then its target.
        const checkpoint = await manager.findOne(Checkpoint, {
          where: { id: selected.id, organizationId: organization.id },
          lock: { mode: 'pessimistic_write' },
        })
        if (!checkpoint || checkpoint.state !== 'ready' || !checkpoint.archive)
          throw new ConflictException('Checkpoint is not ready')
        const box = await manager.findOne(Box, {
          where: { id: selectedTarget.id, organizationId: organization.id },
          lock: { mode: 'pessimistic_write' },
        })
        if (!box) throw new NotFoundException('Recovery target not found')
        const checkpointState =
          (await manager.findOne(BoxCheckpointState, {
            where: { boxId: box.id },
            lock: { mode: 'pessimistic_write' },
          })) ?? manager.create(BoxCheckpointState, { boxId: box.id })
        if (await manager.exists(BoxMigration, { where: { boxId: box.id, state: Not(BoxMigrationState.COMPLETED) } }))
          throw new ConflictException('Checkpoint recovery target is migrating')
        if (box.volumes?.length || box.secrets?.length)
          throw new BadRequestException('Checkpoint recovery targets with volumes or secrets are not supported')
        const previous = await manager.findOne(CheckpointOperation, {
          where: { boxId: box.id, state: In(['pending', 'failed']) },
          lock: { mode: 'pessimistic_write' },
        })
        if (previous?.state === 'pending') {
          if (previous.checkpointId === checkpoint.id && checkpointState.activeJobId === previous.jobId) return box
          throw new ConflictException('Target already has a checkpoint operation')
        }
        if (previous && (previous.checkpointId !== checkpoint.id || previous.jobId !== checkpointState.activeJobId))
          throw new ConflictException('Target has another unfinished checkpoint operation')
        if (!previous && (box.pending || checkpointState.activeJobId))
          throw new ConflictException('Target has a state change in progress')
        if (
          ![BoxState.STOPPED, BoxState.ERROR].includes(box.state) ||
          ![BoxDesiredState.STOPPED, BoxDesiredState.STARTED].includes(box.desiredState) ||
          (box.state === BoxState.STOPPED && box.desiredState !== BoxDesiredState.STOPPED)
        )
          throw new ConflictException('Checkpoint recovery requires an idle stopped or error target')
        const runner = box.runnerId
          ? await manager.findOne(Runner, {
              where: { id: box.runnerId },
              lock: { mode: 'pessimistic_read' },
            })
          : null
        if (previous && previous.runnerId !== box.runnerId)
          throw new ConflictException('Checkpoint recovery cannot move to another runner')
        this.assertRunner(runner, checkpoint)
        if (
          await manager.exists(Job, {
            where: {
              resourceType: In([ResourceType.BOX, ResourceType.BACKUP]),
              resourceId: box.id,
              completedAt: IsNull(),
            },
          })
        )
          throw new ConflictException('Target has an unfinished runner job')
        if (previous) {
          // A completed runner job can still have an unusable receipt. The
          // failed logical operation owns its retry, regardless of which
          // terminal job status delivered that failure.
          const terminalJob = await manager.findOneBy(Job, {
            id: previous.jobId,
            type: JobType.IMPORT_CHECKPOINT,
            runnerId: runner.id,
            resourceType: ResourceType.BOX,
            resourceId: box.id,
            status: In([JobStatus.COMPLETED, JobStatus.FAILED]),
          })
          if (!terminalJob) throw new ConflictException('Previous checkpoint attempt has not finished')
        }
        await this.schedule(manager, checkpoint, box, 'recover', checkpointState, previous ?? undefined)
        box.assertValid()
        box.enforceInvariants()
        await manager.save(Box, box)
        return box
      },
    )
    this.cache.invalidate(box)
    return box
  }

  private async admit(organization: Organization, key: string): Promise<Checkpoint> {
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
    mode: 'create' | 'recover',
    checkpointState: BoxCheckpointState,
    previous?: CheckpointOperation,
  ): Promise<void> {
    const operation =
      previous ??
      manager.create(CheckpointOperation, {
        id: randomUUID(),
        organizationId: box.organizationId,
        checkpointId: checkpoint.id,
        boxId: box.id,
        runnerId: box.runnerId,
        sequence: checkpointState.sequence + 1,
        mode,
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
