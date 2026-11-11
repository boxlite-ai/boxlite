// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { randomUUID } from 'node:crypto'
import { DataSource, In, IsNull, MoreThan, Not } from 'typeorm'
import { isUUID } from 'class-validator'
import { Box } from '../entities/box.entity'
import { BoxCheckpointState } from '../entities/box-checkpoint-state.entity'
import { Checkpoint, CheckpointEnvironment } from '../entities/checkpoint.entity'
import { Runner } from '../entities/runner.entity'
import { BoxState } from '../enums/box-state.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from './job.service'
import { BoxLookupCacheInvalidationService } from './box-lookup-cache-invalidation.service'
import { checkpointConfig } from '../../config/checkpoint-config'
import { Job } from '../entities/job.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { CheckpointOperation } from '../entities/checkpoint-operation.entity'
import { CheckpointArchiveStore } from '../stores/checkpoint-archive.store'

@Injectable()
export class CheckpointService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly jobs: JobService,
    private readonly cache: BoxLookupCacheInvalidationService,
    private readonly archives: CheckpointArchiveStore,
  ) {}

  assertEnabled(): ReturnType<typeof checkpointConfig> {
    const settings = this.config.get<ReturnType<typeof checkpointConfig>>('checkpoint')
    if (!settings?.enabled || !settings.archivePrefix) {
      throw new ServiceUnavailableException('Checkpoint storage is not configured or admission is disabled')
    }
    return settings
  }

  async create(organizationId: string, source: string, name?: string): Promise<Checkpoint> {
    if (!source || source.includes('\0') || source.length > 128) throw new BadRequestException('Invalid source box')
    if (name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
      throw new BadRequestException('Invalid checkpoint name')
    const settings = this.assertEnabled()
    let sourceBox: Box | undefined
    try {
      const checkpoint = await this.dataSource.transaction(async (manager) => {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`checkpoint-quota:${organizationId}`])
        if (name && isUUID(name) && (await manager.exists(Checkpoint, { where: { organizationId, id: name } })))
          throw new ConflictException('Checkpoint name conflicts with an existing checkpoint ID')
        const byId = await manager.findOne(Box, {
          where: { organizationId, id: source },
          lock: { mode: 'pessimistic_write' },
        })
        const box =
          byId ??
          (await manager.findOne(Box, {
            where: { organizationId, name: source },
            lock: { mode: 'pessimistic_write' },
          }))
        if (!box) throw new NotFoundException('Source box not found')
        // The parent lock also serializes first use, when no coordination row exists yet.
        const checkpointState =
          (await manager.findOne(BoxCheckpointState, {
            where: { boxId: box.id },
            lock: { mode: 'pessimistic_write' },
          })) ?? manager.create(BoxCheckpointState, { boxId: box.id })
        if (
          box.pending ||
          checkpointState.activeJobId ||
          String(box.state) !== String(box.desiredState) ||
          box.state !== BoxState.STOPPED
        ) {
          throw new ConflictException(
            'Checkpoint source must be idle and stopped; stop the Box before creating a checkpoint',
          )
        }
        if (box.volumes?.length || box.secrets?.length)
          throw new BadRequestException('Checkpoints with volumes or secrets are not supported')
        if (await manager.exists(BoxMigration, { where: { boxId: box.id, state: Not(BoxMigrationState.COMPLETED) } })) {
          throw new ConflictException('Checkpoint source is migrating')
        }
        const runner = box.runnerId
          ? await manager.findOneBy(Runner, {
              id: box.runnerId,
              state: RunnerState.READY,
              apiVersion: '2',
              draining: false,
            })
          : null
        if (!runner) throw new ConflictException('Source runner is not ready for checkpoint jobs')
        if (
          await manager.exists(Job, {
            where: {
              resourceType: In([ResourceType.BOX, ResourceType.BACKUP]),
              resourceId: box.id,
              runnerId: runner.id,
              completedAt: IsNull(),
            },
          })
        ) {
          throw new ConflictException('Source box already has an unfinished job')
        }
        if ((await manager.countBy(Checkpoint, { organizationId })) >= settings.maxPerOrganization)
          throw new ConflictException('Checkpoint limit reached')
        const id = randomUUID()
        const checkpoint = manager.create(Checkpoint, {
          id,
          organizationId,
          name: name ?? `checkpoint-${id}`,
          sourceBoxId: box.id,
          sourceRunnerId: runner.id,
          sourceState: box.state,
          state: 'creating',
          arcPath: `${settings.archivePrefix}${organizationId}/${id}/archive.boxlite`,
          environment: captureEnvironment(box),
          archive: null,
          errorReason: null,
        })
        const job = await this.jobs.createJob(manager, JobType.EXPORT_CHECKPOINT, runner.id, ResourceType.BOX, box.id, {
          checkpointId: id,
          arcPath: checkpoint.arcPath,
        })
        checkpoint.exportJobId = job.id
        checkpoint.activeJobId = job.id
        await manager.insert(Checkpoint, checkpoint)
        checkpointState.activeJobId = job.id
        await manager.save(BoxCheckpointState, checkpointState)
        await manager.update(Box, { id: box.id }, { pending: true })
        sourceBox = box
        return checkpoint
      })
      if (sourceBox) this.cache.invalidate(sourceBox)
      return checkpoint
    } catch (error) {
      if (error?.code === '23505' && error.constraint === 'checkpoint_org_name_key')
        throw new ConflictException('Checkpoint name already exists')
      throw error
    }
  }

  async get(organizationId: string, key: string): Promise<Checkpoint> {
    const repository = this.dataSource.getRepository(Checkpoint)
    const byId = isUUID(key) ? await repository.findOneBy({ organizationId, id: key }) : null
    const checkpoint = byId ?? (await repository.findOneBy({ organizationId, name: key }))
    if (!checkpoint) throw new NotFoundException('Checkpoint not found')
    return checkpoint
  }

  async list(
    organizationId: string,
    pageToken?: string,
  ): Promise<{ checkpoints: Checkpoint[]; nextPageToken?: string }> {
    if (pageToken && !isUUID(pageToken)) throw new BadRequestException('Invalid checkpoint page token')
    const rows = await this.dataSource.getRepository(Checkpoint).find({
      where: { organizationId, ...(pageToken ? { id: MoreThan(pageToken) } : {}) },
      order: { id: 'ASC' },
      take: 101,
    })
    return { checkpoints: rows.slice(0, 100), nextPageToken: rows.length > 100 ? rows[99].id : undefined }
  }

  async remove(organizationId: string, key: string, force = false): Promise<void> {
    let selected: Checkpoint
    try {
      selected = await this.get(organizationId, key)
    } catch (error) {
      if (force && error instanceof NotFoundException) return
      throw error
    }
    const checkpoint = await this.dataSource.transaction(async (manager) => {
      const checkpoint = await manager.findOne(Checkpoint, {
        where: { id: selected.id, organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!checkpoint) {
        if (force) return null
        throw new NotFoundException('Checkpoint not found')
      }
      if (
        checkpoint.state === 'creating' ||
        checkpoint.activeJobId ||
        (await manager.exists(CheckpointOperation, {
          where: { checkpointId: checkpoint.id, state: In(['pending', 'failed']) },
        }))
      )
        throw new ConflictException('Checkpoint is being created or used by a Box operation')
      if (
        await manager
          .getRepository(CheckpointOperation)
          .createQueryBuilder('operation')
          .innerJoin(Box, 'target', 'target.id = operation."boxId"')
          .where('operation."checkpointId" = :checkpointId', { checkpointId: checkpoint.id })
          .andWhere('operation.state = :cancelled', { cancelled: 'cancelled' })
          .andWhere('target.state <> :destroyed', { destroyed: BoxState.DESTROYED })
          .getExists()
      )
        throw new ConflictException('Checkpoint target destruction is still pending; retry deletion')
      checkpoint.state = 'deleting'
      return manager.save(Checkpoint, checkpoint)
    })
    if (!checkpoint) return
    // No database lock spans object I/O. The durable deleting state refuses
    // new uses; a failed delete keeps the record for an idempotent retry.
    await this.archives.remove(checkpoint)
    await this.dataSource.transaction(async (manager) => {
      const current = await manager.findOne(Checkpoint, {
        where: { id: checkpoint.id, organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!current) return
      if (current.state !== 'deleting') throw new ConflictException('Checkpoint deletion ownership changed')
      await manager.delete(CheckpointOperation, { checkpointId: checkpoint.id, state: In(['completed', 'cancelled']) })
      await manager.delete(Checkpoint, { id: checkpoint.id, organizationId })
    })
  }
}

function captureEnvironment(box: Box): CheckpointEnvironment {
  return {
    image: box.image,
    imageIsOrgOwned: box.imageIsOrgOwned,
    region: box.region,
    class: box.class,
    cpu: box.cpu,
    mem: box.mem,
    disk: box.disk,
    gpu: box.gpu,
    osUser: box.osUser,
    runAsUser: box.runAsUser,
    privileged: box.privileged,
    workingDir: box.workingDir,
    entrypoint: box.entrypoint,
    cmd: box.cmd,
    env: box.env,
    labels: box.labels,
    inboundEnabled: box.inboundEnabled,
    outboundEnabled: box.outboundEnabled,
    outboundAllowNet: box.outboundAllowNet,
    autoStop: box.autoStop,
    autoDelete: box.autoDelete,
    autoResume: box.autoResume,
  }
}
