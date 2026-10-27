/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { randomUUID } from 'crypto'
import { DataSource, EntityManager, In, Not } from 'typeorm'
import { validate as isUuid } from 'uuid'

import { Box } from '../entities/box.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxSnapshot } from '../entities/box-snapshot.entity'
import { BoxSnapshotRestore } from '../entities/box-snapshot-restore.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxSnapshotRestoreState } from '../enums/box-snapshot-restore-state.enum'
import { BoxSnapshotState } from '../enums/box-snapshot-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { BoxSnapshotAdmissionUnavailableError, BoxSnapshotLimitExceededError } from '../errors/box-snapshot-limit.error'
import { JobConflictError } from '../errors/job-conflict.error'
import { BoxRepository, PG_LOCK_TIMEOUT_CODE } from '../repositories/box.repository'
import { assertNoSnapshotOperation } from '../utils/box-state.util'
import { generateBoxName } from '../utils/box-name-generator'
import { BoxService } from './box.service'
import { JobService } from './job.service'
import { TypedConfigService } from '../../config/typed-config.service'

/** What a CREATE_SNAPSHOT or RESTORE_SNAPSHOT job tells its runner: the archive to write or read. */
interface SnapshotArchivePayload {
  archiveUri: string
}

// First key of the two-key advisory lock that queues one organization's
// snapshot creates, apart from every other advisory-lock use ('SNAP').
export const SNAPSHOT_ADMISSION_LOCK_NAMESPACE = 0x534e4150
// A queued create pins a pooled connection while it waits, so the wait is
// capped, as box admission caps its own; the holder only writes a few rows.
const SNAPSHOT_ADMISSION_LOCK_TIMEOUT_MS = 5000

/** Narrows a lookup to the snapshots taken from one box. */
export interface SnapshotScope {
  sourceBoxId?: string
}

/**
 * Snapshots of stopped boxes, kept in object storage under the organization.
 *
 * Creating and restoring both hand a stopped box's disk to a runner job. The
 * request that does so is one transaction: it locks the box, checks it is
 * stopped and idle, records the snapshot (or restore) with its job, and moves
 * the box to EXPORTING (or IMPORTING). Nothing is left half-submitted, and the
 * box's own state is what keeps every other change out until the job settles
 * (BoxSnapshotSettler). Deleting the box is the one change still allowed, and
 * it fails the snapshot or restore.
 */
@Injectable()
export class BoxSnapshotService {
  private readonly archivePrefix: string | undefined
  private readonly maxPerOrganization: number

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly boxRepository: BoxRepository,
    private readonly boxService: BoxService,
    private readonly jobService: JobService,
    configService: TypedConfigService,
  ) {
    this.archivePrefix = configService.get('boxSnapshot.archivePrefix')
    this.maxPerOrganization = configService.get('boxSnapshot.maxPerOrganization')
  }

  /** Whether this server stores snapshots at all: an archive prefix is configured. */
  isEnabled(): boolean {
    return Boolean(this.archivePrefix)
  }

  async create(boxIdOrName: string, name: string | undefined, organizationId: string): Promise<BoxSnapshot> {
    const prefix = this.requirePrefix()
    const source = await this.boxService.findOneByIdOrName(boxIdOrName, organizationId)
    const boxId = source.id
    const requestedName = name?.trim()
    name = requestedName || generateBoxName()
    if (!name || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new BadRequestException(
        'Provide a snapshot name of 1–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit',
      )
    }
    const id = randomUUID()
    // Fixed now, so a later change of the configured prefix strands nothing.
    const archiveUri = `${prefix}${organizationId}/${id}.boxlite`

    return this.submit(async (entityManager) => {
      await this.queueForOrganization(entityManager, organizationId)
      const box = await this.lockIdleStoppedBox(entityManager, boxId)

      const kept = await entityManager.count(BoxSnapshot, {
        where: { organizationId, state: In([BoxSnapshotState.CREATING, BoxSnapshotState.READY]) },
      })
      if (kept >= this.maxPerOrganization) {
        throw new BoxSnapshotLimitExceededError(kept, this.maxPerOrganization)
      }

      // The organization lock serializes this check with every snapshot insert.
      // Choose the fallback before writing: a uniqueness error aborts the transaction.
      if (
        !requestedName &&
        (await entityManager.exists(BoxSnapshot, {
          where: { organizationId, name, state: Not(BoxSnapshotState.DELETING) },
        }))
      ) {
        name = `${name}-${id}`
      }

      // A failed snapshot never held a usable archive. Its caller has already
      // been told why, so a retry under the same name retires it instead of
      // being refused; the reaper removes whatever object it left.
      await entityManager.update(
        BoxSnapshot,
        { organizationId, name, state: BoxSnapshotState.FAILED },
        { state: BoxSnapshotState.DELETING },
      )

      const payload: SnapshotArchivePayload = { archiveUri }
      const job = await this.jobService.createJob(
        entityManager,
        JobType.CREATE_SNAPSHOT,
        box.runnerId,
        ResourceType.BACKUP,
        box.id,
        payload,
      )
      await entityManager.insert(BoxSnapshot, {
        id,
        organizationId,
        name,
        sourceBoxId: box.id,
        region: box.region,
        diskGb: box.disk,
        state: BoxSnapshotState.CREATING,
        archiveUri,
        jobId: job.id,
      })
      // Last, so a refusal above emits no state change it would have to undo.
      await this.boxRepository.updateWhere(box.id, this.leaveStopped(BoxState.EXPORTING), entityManager)

      return entityManager.findOneByOrFail(BoxSnapshot, { id })
    }, name)
  }

  async restore(boxIdOrName: string, snapshotIdOrName: string, organizationId: string): Promise<BoxSnapshotRestore> {
    this.requirePrefix()
    const { id: boxId } = await this.boxService.findOneByIdOrName(boxIdOrName, organizationId)
    const { id: snapshotId } = await this.findOne(organizationId, snapshotIdOrName)
    const id = randomUUID()

    return this.submit(async (entityManager) => {
      const box = await this.lockIdleStoppedBox(entityManager, boxId)
      // FOR SHARE: a delete of this snapshot waits for the restore to be
      // recorded, then finds it pending and refuses.
      const snapshot = await entityManager.findOne(BoxSnapshot, {
        where: { id: snapshotId },
        lock: { mode: 'pessimistic_read' },
      })
      if (!snapshot || snapshot.state !== BoxSnapshotState.READY) {
        throw new ConflictException(
          `Snapshot ${snapshotIdOrName} is ${snapshot?.state ?? 'gone'}; only a ready snapshot can be restored`,
        )
      }
      if (snapshot.diskGb !== box.disk) {
        throw new ConflictException(
          `Snapshot ${snapshot.name} holds a ${snapshot.diskGb} GiB disk, but box ${box.id} has ${box.disk} GiB`,
        )
      }
      if (snapshot.region !== box.region) {
        throw new ConflictException(
          `Snapshot ${snapshot.name} is stored for region ${snapshot.region}, but box ${box.id} runs in ${box.region}`,
        )
      }

      const payload: SnapshotArchivePayload = { archiveUri: snapshot.archiveUri }
      const job = await this.jobService.createJob(
        entityManager,
        JobType.RESTORE_SNAPSHOT,
        box.runnerId,
        ResourceType.BACKUP,
        box.id,
        payload,
      )
      await entityManager.insert(BoxSnapshotRestore, {
        id,
        organizationId,
        boxId: box.id,
        snapshotId: snapshot.id,
        state: BoxSnapshotRestoreState.PENDING,
        jobId: job.id,
      })
      await this.boxRepository.updateWhere(box.id, this.leaveStopped(BoxState.IMPORTING), entityManager)

      return entityManager.findOneByOrFail(BoxSnapshotRestore, { id })
    })
  }

  async getRestore(boxIdOrName: string, restoreId: string, organizationId: string): Promise<BoxSnapshotRestore> {
    const { id: boxId } = await this.boxService.findOneByIdOrName(boxIdOrName, organizationId, true)
    const restore = isUuid(restoreId)
      ? await this.dataSource.getRepository(BoxSnapshotRestore).findOneBy({ id: restoreId, boxId, organizationId })
      : null
    if (!restore) {
      throw new NotFoundException(`Restore ${restoreId} not found`)
    }
    return restore
  }

  async list(organizationId: string, scope: SnapshotScope = {}): Promise<BoxSnapshot[]> {
    return this.dataSource.getRepository(BoxSnapshot).find({
      where: { organizationId, state: Not(BoxSnapshotState.DELETING), ...scope },
      order: { createdAt: 'DESC' },
    })
  }

  /** By id or name. A name is unique among the snapshots not being deleted. */
  async findOne(organizationId: string, idOrName: string, scope: SnapshotScope = {}): Promise<BoxSnapshot> {
    const repository = this.dataSource.getRepository(BoxSnapshot)
    const where = { organizationId, state: Not(BoxSnapshotState.DELETING), ...scope }
    const snapshot =
      (isUuid(idOrName) ? await repository.findOneBy({ ...where, id: idOrName }) : null) ??
      (await repository.findOneBy({ ...where, name: idOrName }))
    if (!snapshot) {
      throw new NotFoundException(`Snapshot ${idOrName} not found`)
    }
    return snapshot
  }

  /**
   * Hand the snapshot to the reaper, which removes its archive and then its
   * row. Refused while the archive is still being written, or while a restore
   * is reading it.
   */
  async remove(organizationId: string, idOrName: string, scope: SnapshotScope = {}): Promise<void> {
    const { id } = await this.findOne(organizationId, idOrName, scope)

    await this.dataSource.transaction(async (entityManager) => {
      const snapshot = await entityManager.findOne(BoxSnapshot, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      })
      if (!snapshot || snapshot.state === BoxSnapshotState.DELETING) {
        return
      }
      if (snapshot.state === BoxSnapshotState.CREATING) {
        throw new ConflictException(`Snapshot ${snapshot.name} is still being created`)
      }
      const restoring = await entityManager.exists(BoxSnapshotRestore, {
        where: { snapshotId: id, state: BoxSnapshotRestoreState.PENDING },
      })
      if (restoring) {
        throw new ConflictException(`Snapshot ${snapshot.name} is being restored into a box`)
      }
      if (await entityManager.exists(Box, { where: { initialSnapshotId: id } })) {
        throw new ConflictException(`Snapshot ${snapshot.name} is being used to create a box`)
      }
      await entityManager.update(BoxSnapshot, { id }, { state: BoxSnapshotState.DELETING })
    })
  }

  private requirePrefix(): string {
    if (!this.archivePrefix) {
      throw new ServiceUnavailableException('Box snapshots are not configured on this server')
    }
    return this.archivePrefix
  }

  /**
   * Lock the box, and admit it only if it is stopped with nothing in flight:
   * no state change pending, no snapshot job, no move to another runner.
   */
  private async lockIdleStoppedBox(entityManager: EntityManager, boxId: string): Promise<Box> {
    const box = await entityManager.findOne(Box, {
      where: { id: boxId },
      lock: { mode: 'pessimistic_write' },
      loadEagerRelations: false,
    })
    if (!box) {
      throw new NotFoundException(`Box ${boxId} not found`)
    }
    assertNoSnapshotOperation(box)
    if (box.state !== BoxState.STOPPED || box.desiredState !== BoxDesiredState.STOPPED || box.pending) {
      throw new ConflictException(`Box ${box.id} must be stopped (state: ${box.state})`)
    }
    if (!box.runnerId) {
      throw new ConflictException(`Box ${box.id} has no runner holding its disk`)
    }
    if (await entityManager.exists(BoxMigration, { where: { boxId: box.id } })) {
      throw new ConflictException(`Box ${box.id} is being moved to another runner`)
    }
    return box
  }

  private leaveStopped(state: BoxState.EXPORTING | BoxState.IMPORTING) {
    return {
      updateData: { state },
      whereCondition: { state: BoxState.STOPPED, desiredState: BoxDesiredState.STOPPED, pending: false },
    }
  }

  /**
   * Queue behind the organization's other creates, before the count: under
   * READ COMMITTED each statement reads a fresh snapshot, so the count then
   * includes what the previous holder committed, and the cap holds. One
   * statement caps the wait and restores the default, as box admission does.
   */
  private async queueForOrganization(entityManager: EntityManager, organizationId: string): Promise<void> {
    try {
      await entityManager.query(
        `SELECT set_config('lock_timeout', $1, true),
                pg_advisory_xact_lock($2, hashtext($3)),
                set_config('lock_timeout', (SELECT reset_val FROM pg_settings WHERE name = 'lock_timeout'), true)`,
        [`${SNAPSHOT_ADMISSION_LOCK_TIMEOUT_MS}ms`, SNAPSHOT_ADMISSION_LOCK_NAMESPACE, organizationId],
      )
    } catch (error) {
      if ((error as { code?: string }).code === PG_LOCK_TIMEOUT_CODE) {
        throw new BoxSnapshotAdmissionUnavailableError()
      }
      throw error
    }
  }

  /** Run a submission, turning the conflicts its writes can hit into 409s. */
  private async submit<T>(work: (entityManager: EntityManager) => Promise<T>, name?: string): Promise<T> {
    try {
      return await this.dataSource.transaction(work)
    } catch (error) {
      if (error instanceof JobConflictError) {
        throw new ConflictException('The box already has an archive job in progress')
      }
      if ((error as { code?: string }).code === '23505' && name !== undefined) {
        throw new ConflictException(`A snapshot named ${name} already exists`)
      }
      throw error
    }
  }
}
