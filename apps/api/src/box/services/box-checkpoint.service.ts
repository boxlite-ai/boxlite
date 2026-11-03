/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { randomUUID } from 'crypto'
import { DataSource, EntityManager, In, Not } from 'typeorm'
import { validate as isUuid } from 'uuid'
import { Box } from '../entities/box.entity'
import { BoxCheckpoint, BoxCheckpointOperation, CheckpointConfiguration } from '../entities/box-checkpoint.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Runner } from '../entities/runner.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobConflictError } from '../errors/job-conflict.error'
import { BoxRepository } from '../repositories/box.repository'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxService } from './box.service'
import { JobService } from './job.service'
import { assertNoSnapshotOperation } from '../utils/box-state.util'
import { OrganizationService } from '../../organization/services/organization.service'

export interface CheckpointScope {
  sourceBoxId?: string
}

export function checkpointUnsupported(message: string): HttpException {
  return new HttpException({ error: { type: 'UnsupportedError', code: 'unsupported', message } }, 400)
}

/** Translate native categories, never error text or the upload stage. */
export function checkpointNativeError(
  error: { type?: string; code?: string; message?: string } | null | undefined,
): HttpException | null {
  const categories = {
    InvalidArgumentError: ['invalid_argument', 400],
    UnsupportedError: ['unsupported', 400],
    InvalidStateError: ['invalid_state', 409],
    StorageError: ['storage_error', 500],
    DatabaseError: ['database_error', 500],
    InternalError: ['internal', 500],
    NotFoundError: ['not_found', 404],
    SessionReapedError: ['session_reaped', 410],
    AlreadyExistsError: ['already_exists', 409],
    StoppedError: ['stopped', 409],
    ImageError: ['image_pull_failed', 422],
    ExecutionError: ['execution_failed', 422],
    ResourceExhaustedError: ['resource_exhausted', 429],
    NetworkError: ['network_unavailable', 503],
    UpstreamUnavailableError: ['upstream_unavailable', 503],
    EngineError: ['engine_unavailable', 503],
    MetadataError: ['metadata_error', 500],
    ConfigError: ['config_error', 500],
  } as const
  const category = categories[error?.type]
  return category && error.code === category[0] && typeof error.message === 'string'
    ? new HttpException({ error }, category[1])
    : null
}

export function checkpointName(name?: string): string {
  const value = name === undefined ? randomUUID() : name
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
    throw new BadRequestException('Checkpoint name must be 1–128 path-safe ASCII characters')
  return value
}

export function checkpointConfiguration(box: Box): CheckpointConfiguration {
  return {
    image: box.image,
    env: Object.entries(box.env),
    working_dir: box.workingDir,
    user: box.runAsUser,
    entrypoint: box.entrypoint,
    cmd: box.cmd,
    tty: false,
    privileged: box.privileged,
    outbound: {
      mode: box.outboundEnabled ? 'enabled' : 'disabled',
      ...(box.outboundAllowNet ? { allow_net: box.outboundAllowNet } : {}),
    },
    inbound: { mode: box.inboundEnabled ? 'enabled' : 'disabled' },
  }
}

@Injectable()
export class BoxCheckpointService {
  private readonly prefix: string | undefined
  private readonly maximum: number

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly boxes: BoxService,
    private readonly repository: BoxRepository,
    private readonly jobs: JobService,
    config: TypedConfigService,
    private readonly organizations: OrganizationService,
  ) {
    const storage = config.get('boxCheckpoint')
    this.prefix = storage.archivePrefix
    this.maximum = storage.maxPerOrganization
  }

  async isEnabled(): Promise<boolean> {
    return (
      Boolean(this.prefix) &&
      this.dataSource.getRepository(Runner).exists({
        where: {
          apiVersion: '2',
          checkpointsEnabled: true,
          state: RunnerState.READY,
          unschedulable: false,
          draining: false,
        },
      })
    )
  }

  requireStorage(): string {
    if (!this.prefix) throw checkpointUnsupported('Memory checkpoint storage is not configured')
    return this.prefix
  }

  async requireRunner(manager: EntityManager, runnerId: string): Promise<Runner> {
    const runner =
      runnerId &&
      (await manager.findOneBy(Runner, {
        id: runnerId,
        apiVersion: '2',
        checkpointsEnabled: true,
        state: RunnerState.READY,
      }))
    if (!runner) throw checkpointUnsupported('The runner does not support memory checkpoints')
    return runner
  }

  async pause(boxId: string, organizationId: string): Promise<void> {
    await this.changeState(boxId, organizationId, 'pause')
  }
  async resume(boxId: string, organizationId: string): Promise<void> {
    await this.changeState(boxId, organizationId, 'resume')
  }

  private async changeState(selector: string, organizationId: string, kind: 'pause' | 'resume'): Promise<void> {
    this.requireStorage()
    const source = await this.boxes.findOneByIdOrName(selector, organizationId)
    if (kind === 'resume') {
      const organization = await this.organizations.findOne(organizationId)
      if (!organization) throw new NotFoundException('Organization not found')
      this.organizations.assertOrganizationIsNotSuspended(organization)
    }
    const operationId = await this.submit(async (manager) => {
      const box = await this.lockIdle(
        manager,
        source.id,
        organizationId,
        kind === 'pause' ? BoxState.STARTED : BoxState.PAUSED,
      )
      const operationId = randomUUID()
      const job = await this.jobs.createJob(
        manager,
        kind === 'pause' ? JobType.PAUSE_BOX : JobType.RESUME_BOX,
        box.runnerId,
        ResourceType.BACKUP,
        box.id,
        { operationId },
      )
      await manager.insert(BoxCheckpointOperation, {
        id: operationId,
        organizationId,
        boxId: box.id,
        jobId: job.id,
        kind,
        checkpointId: null,
        state: 'pending',
      })
      await this.repository.updateWhere(
        box.id,
        {
          updateData: {
            checkpointOperationId: operationId,
            desiredState: kind === 'pause' ? BoxDesiredState.PAUSED : BoxDesiredState.STARTED,
          },
          whereCondition: { state: box.state, pending: false },
        },
        manager,
      )
      return operationId
    })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const operation = await this.dataSource.getRepository(BoxCheckpointOperation).findOneByOrFail({ id: operationId })
      if (operation.state === 'succeeded') return
      if (operation.state === 'failed')
        throw (
          checkpointNativeError(operation.error?.error as any) ??
          new HttpException(
            { error: { type: 'InvalidStateError', code: 'invalid_state', message: 'Checkpoint state change failed' } },
            409,
          )
        )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new HttpException(
      {
        error: {
          type: 'TimeoutError',
          code: 'timeout',
          message: `Box ${source.id} operation ${operationId} is still pending; inspect the box before retrying`,
        },
      },
      504,
    )
  }

  async create(selector: string, name: string | undefined, organizationId: string): Promise<BoxCheckpoint> {
    const prefix = this.requireStorage()
    const source = await this.boxes.findOneByIdOrName(selector, organizationId)
    const id = randomUUID(),
      operationId = randomUUID(),
      selectedName = checkpointName(name)
    return this.submit(async (manager) => {
      await this.queueOrganization(manager, organizationId)
      const box = await this.lockIdle(manager, source.id, organizationId, BoxState.PAUSED)
      const count = await manager.count(BoxCheckpoint, {
        where: { organizationId, visible: true, state: In(['creating', 'ready']) },
      })
      if (count >= this.maximum)
        throw new HttpException({ code: 'checkpoint_limit_exceeded', message: 'Checkpoint quota exceeded' }, 429)
      const archiveUri = `${prefix}${organizationId}/${id}.checkpoint`
      const job = await this.jobs.createJob(
        manager,
        JobType.CREATE_CHECKPOINT,
        box.runnerId,
        ResourceType.BACKUP,
        box.id,
        { operationId, checkpointId: id, archiveUri },
      )
      await manager.insert(BoxCheckpoint, {
        id,
        organizationId,
        name: selectedName,
        sourceBoxId: box.id,
        region: box.region,
        state: 'creating',
        archiveUri,
        configuration: checkpointConfiguration(box),
        cpus: box.cpu,
        memoryMib: box.mem * 1024,
        diskGb: box.disk,
      })
      await manager.insert(BoxCheckpointOperation, {
        id: operationId,
        organizationId,
        boxId: box.id,
        checkpointId: id,
        jobId: job.id,
        kind: 'capture',
        state: 'pending',
      })
      await this.repository.updateWhere(
        box.id,
        {
          updateData: { checkpointOperationId: operationId },
          whereCondition: { state: BoxState.PAUSED, desiredState: BoxDesiredState.PAUSED, pending: false },
        },
        manager,
      )
      return manager.findOneByOrFail(BoxCheckpoint, { id })
    }, selectedName)
  }

  async list(organizationId: string, scope: CheckpointScope = {}): Promise<BoxCheckpoint[]> {
    return this.dataSource.getRepository(BoxCheckpoint).find({
      where: { organizationId, ...scope, visible: true, state: Not('deleting') },
      order: { createdAt: 'DESC' },
    })
  }

  async findOne(organizationId: string, selector: string, scope: CheckpointScope = {}): Promise<BoxCheckpoint> {
    const repository = this.dataSource.getRepository(BoxCheckpoint),
      where = { organizationId, ...scope, visible: true }
    const found =
      (isUuid(selector) ? await repository.findOneBy({ ...where, id: selector }) : null) ??
      (await repository.findOneBy({ ...where, name: selector, state: Not('deleting') }))
    if (!found) throw new NotFoundException('Checkpoint not found')
    return found
  }

  async remove(organizationId: string, selector: string, scope: CheckpointScope = {}): Promise<void> {
    const selected = await this.findOne(organizationId, selector, scope)
    await this.dataSource.transaction(async (manager) => {
      const resource = await manager.findOne(BoxCheckpoint, {
        where: { id: selected.id, organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!resource || resource.state === 'deleting') return
      if (
        resource.state === 'creating' ||
        (await manager.exists(BoxCheckpointOperation, { where: { checkpointId: resource.id, state: 'pending' } })) ||
        (await manager.exists(Box, { where: { initialCheckpointId: resource.id } }))
      )
        throw new ConflictException('Checkpoint is in use')
      await manager.update(BoxCheckpoint, { id: resource.id }, { state: 'deleting' })
    })
  }

  private async lockIdle(manager: EntityManager, id: string, organizationId: string, state: BoxState): Promise<Box> {
    const box = await manager.findOne(Box, {
      where: { id, organizationId },
      lock: { mode: 'pessimistic_write' },
      loadEagerRelations: false,
    })
    if (!box) throw new NotFoundException('Box not found')
    assertNoSnapshotOperation(box)
    if (box.state !== state || String(box.desiredState) !== String(state) || box.pending)
      throw new ConflictException(`Box must be idle and ${state}`)
    await this.requireRunner(manager, box.runnerId)
    if (box.volumes?.length || box.secrets?.length || box.nestedVirtualization)
      throw checkpointUnsupported('Checkpoint does not support this box configuration')
    if (await manager.exists(BoxMigration, { where: { boxId: box.id } }))
      throw new ConflictException('Box is being migrated')
    return box
  }

  private async queueOrganization(manager: EntityManager, organizationId: string): Promise<void> {
    await manager.query("SELECT set_config('lock_timeout', '5s', true), pg_advisory_xact_lock($1, hashtext($2))", [
      0x43485054,
      organizationId,
    ])
  }

  private async submit<T>(work: (manager: EntityManager) => Promise<T>, name?: string): Promise<T> {
    try {
      return await this.dataSource.transaction(work)
    } catch (error) {
      if (error instanceof JobConflictError || error.code === '23505')
        throw new ConflictException(
          name ? `Checkpoint name ${name} is already in use` : 'Box has an operation in progress',
        )
      if (error.code === '55P03') throw new ServiceUnavailableException('Checkpoint admission is busy; retry later')
      throw error
    }
  }
}
