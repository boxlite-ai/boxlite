/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DataSource, EntityManager, FindOptionsWhere } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { BoxConflictError } from '../errors/box-conflict.error'
import { InjectDataSource } from '@nestjs/typeorm'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { BaseRepository } from '../../common/repositories/base.repository'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { BoxDesiredStateUpdatedEvent } from '../events/box-desired-state-updated.event'
import { BoxPublicStatusUpdatedEvent } from '../events/box-public-status-updated.event'
import { BoxOrganizationUpdatedEvent } from '../events/box-organization-updated.event'
import { BoxLookupCacheInvalidationService } from '../services/box-lookup-cache-invalidation.service'

// Cap how long the proxy auto-start UPDATE waits to acquire the box row's
// write lock. Concurrent start/stop/sync go through updateWhere(), which holds
// a pessimistic_write lock on the same row; there is no global statement/lock
// timeout configured (see app.module.ts datasource `extra`), so without this
// bound a contended row could pin a pooled connection indefinitely. On timeout
// Postgres aborts the statement with SQLSTATE 55P03 and we treat it as a
// race-lost no-op. Aligned with the caller-side wait cap in
// boxlite-proxy.controller.ts (PROXY_START_HINT_TIMEOUT_MS).
const PROXY_START_LOCK_TIMEOUT_MS = 2000

// SQLSTATE for `lock_not_available` — raised when a statement waits longer than
// lock_timeout to acquire a lock.
const PG_LOCK_TIMEOUT_CODE = '55P03'

// A box the migration marker may claim, with the stamp its claim copies.
type ParkedBox = { id: string; updatedAt: Date }

@Injectable()
export class BoxRepository extends BaseRepository<Box> {
  private readonly logger = new Logger(BoxRepository.name)

  constructor(
    @InjectDataSource() dataSource: DataSource,
    eventEmitter: EventEmitter2,
    private readonly boxLookupCacheInvalidationService: BoxLookupCacheInvalidationService,
  ) {
    super(dataSource, eventEmitter, Box)
  }

  async insert(box: Box): Promise<Box> {
    const now = new Date()
    if (!box.createdAt) {
      box.createdAt = now
    }
    if (!box.updatedAt) {
      box.updatedAt = now
    }

    box.assertValid()
    box.enforceInvariants()

    await this.dataSource.transaction(async (entityManager) => {
      await entityManager.insert(Box, box)
      await this.upsertLastActivity(entityManager, box.id, box.createdAt)
    })

    this.invalidateLookupCacheOnInsert(box)

    return box
  }

  /**
   * @param id - The ID of the box to update.
   * @param params.updateData - The partial data to update.
   *
   * @returns `void` because a raw update is performed.
   */
  async update(id: string, params: { updateData: Partial<Box> }, raw: true): Promise<void>
  /**
   * @param id - The ID of the box to update.
   * @param params.updateData - The partial data to update.
   * @param params.entity - Optional pre-fetched box to use instead of fetching from the database.
   *
   * @returns The updated box.
   */
  async update(id: string, params: { updateData: Partial<Box>; entity?: Box }, raw?: false): Promise<Box>
  async update(id: string, params: { updateData: Partial<Box>; entity?: Box }, raw = false): Promise<Box | void> {
    const { updateData, entity } = params

    if (raw) {
      await this.repository.update(id, updateData)
      return
    }

    const box = entity ?? (await this.findOneBy({ id }))
    if (!box) {
      throw new NotFoundException('Box not found')
    }

    const previousBox = { ...box }

    Object.assign(box, updateData)
    box.assertValid()
    const invariantChanges = box.enforceInvariants()

    await this.dataSource.transaction(async (entityManager) => {
      const result = await entityManager.update(
        Box,
        {
          id: previousBox.id,
          state: previousBox.state,
          desiredState: previousBox.desiredState,
          pending: previousBox.pending,
          organizationId: previousBox.organizationId,
        },
        { ...updateData, ...invariantChanges },
      )
      if (!result.affected) {
        throw new BoxConflictError()
      }
      box.updatedAt = new Date()

      if (previousBox.state !== box.state || previousBox.organizationId !== box.organizationId) {
        await this.upsertLastActivity(entityManager, id, box.updatedAt)
      }
    })

    this.emitUpdateEvents(box, previousBox)
    this.invalidateLookupCacheOnUpdate(box, previousBox)

    return box
  }

  /**
   * Partially updates a box in the database and optionally emits a corresponding event based on the changes.
   *
   * Performs the update in a transaction with a pessimistic write lock to ensure consistency.
   *
   * @param id - The ID of the box to update.
   * @param params.updateData - The partial data to update.
   * @param params.whereCondition - The where condition to use for the update.
   *
   * @throws {BoxConflictError} if the box was modified by another operation
   */
  async updateWhere(
    id: string,
    params: {
      updateData: Partial<Box>
      whereCondition: FindOptionsWhere<Box>
    },
  ): Promise<Box> {
    const { updateData, whereCondition } = params

    return this.manager.transaction(async (entityManager) => {
      const whereClause = {
        ...whereCondition,
        id,
      }

      const box = await entityManager.findOne(Box, {
        where: whereClause,
        lock: { mode: 'pessimistic_write' },
        relations: [],
        loadEagerRelations: false,
      })

      if (!box) {
        throw new BoxConflictError()
      }

      const previousBox = { ...box }

      Object.assign(box, updateData)
      box.assertValid()
      const invariantChanges = box.enforceInvariants()

      await entityManager.update(Box, id, { ...updateData, ...invariantChanges })
      box.updatedAt = new Date()

      if (previousBox.state !== box.state || previousBox.organizationId !== box.organizationId) {
        await this.upsertLastActivity(entityManager, id, box.updatedAt)
      }

      this.emitUpdateEvents(box, previousBox)
      this.invalidateLookupCacheOnUpdate(box, previousBox)

      return box
    })
  }

  /**
   * Conditionally transitions a stable stopped Box into a start intent.
   * @throws DB errors other than lock-timeout (not wrapped) — caller decides
   *   whether to swallow.
   */
  async conditionalStartForProxy(boxId: string, organizationId: string): Promise<Box | null> {
    try {
      return await this.manager.transaction(async (entityManager) => {
        // Bound the row-lock wait at the DB level. SET LOCAL scopes the timeout
        // to this transaction only, so it never leaks to other queries sharing
        // the pooled connection. The value is a hardcoded constant — no
        // injection surface — but cannot be a bind parameter (SET takes a
        // literal), hence the interpolation.
        await entityManager.query(`SET LOCAL lock_timeout = '${PROXY_START_LOCK_TIMEOUT_MS}ms'`)

        const result = await entityManager
          .createQueryBuilder()
          .update(Box)
          .set({
            pending: true,
            desiredState: BoxDesiredState.STARTED,
            updatedAt: new Date(),
          })
          .where('id = :id', { id: boxId })
          .andWhere('"organizationId" = :org', { org: organizationId })
          .andWhere('pending = false')
          .andWhere('state = :s', { s: BoxState.STOPPED })
          .andWhere('"desiredState" = :d', { d: BoxDesiredState.STOPPED })
          .returning('*')
          .execute()

        const raw = (result.raw as Box[])[0]
        if (!raw) return null

        // RETURNING * yields a plain pg row; hydrate it into a real Box so the
        // value honors the Promise<Box> contract and downstream consumers (the
        // caller's events → toBoxDto) get an entity, not a raw row.
        const updated = entityManager.create(Box, raw)

        // id / name / org haven't changed, but the cached entity snapshot still
        // holds the old desiredState/pending — invalidate so subsequent
        // findOneByIdOrName fetches fresh values.
        this.invalidateLookupCacheOnUpdate(updated, {
          organizationId: updated.organizationId,
          name: updated.name,
          authToken: updated.authToken,
        })

        return updated
      })
    } catch (err) {
      // Lock wait exceeded lock_timeout: the row is being started/stopped
      // concurrently, so we lost the race. No-op — same semantics as a zero-row
      // match. Any other DB error propagates for the caller to handle.
      if ((err as { code?: string }).code === PG_LOCK_TIMEOUT_CODE) {
        return null
      }
      throw err
    }
  }

  /**
   * Opens a migration on every parked box currently owned by one of `runnerIds`,
   * as a `box_migration` row the later steps drive forward.
   *
   * A box is parked when it is stopped and wants to stay stopped, which is the
   * only shape a migration can move. Boxes already part-way through one are left
   * alone; the row a COMPLETED migration left behind is taken over, so a runner
   * that drains a second time re-migrates what it took back.
   *
   * The lock the select takes has to still be held when the insert copies the
   * stamp it read, so both steps share one transaction.
   *
   * @returns How many boxes were marked.
   */
  async markParkedBoxesForExport(runnerIds: string[]): Promise<number> {
    if (runnerIds.length === 0) {
      return 0
    }

    return this.manager.transaction(async (entityManager) => {
      const parked = await this.lockParkedBoxes(entityManager, runnerIds)
      if (parked.length === 0) {
        return 0
      }

      return this.openMigrations(entityManager, parked)
    })
  }

  /**
   * Locks the parked boxes owned by `runnerIds` and reads the stamp to copy.
   *
   * The box is locked rather than written: the lock is what stops a write landing
   * between the read of `updatedAt` and the insert that copies it, and leaving the
   * row untouched keeps a claim from looking like a change to everything else that
   * watches `box.updatedAt`. The lock lives until the caller's transaction ends.
   *
   * SKIP LOCKED passes over the boxes another transaction is holding right now.
   * Those are the boxes about to break the equality anyway, and blocking on one
   * would hold the tick — and the Redis lock it runs under — open behind someone
   * else's transaction.
   */
  private async lockParkedBoxes(entityManager: EntityManager, runnerIds: string[]): Promise<ParkedBox[]> {
    // A box is claimable when no migration owns it — either no row at all, or the
    // row a finished migration left behind — so COMPLETED reads as "not
    // claimable" here and as "claimable" in the conflict guard on the insert.
    const migrationInFlight = entityManager
      .createQueryBuilder()
      .subQuery()
      .select('1')
      .from(BoxMigration, 'migration')
      .where('migration.boxId = box.id')
      .andWhere('migration.state <> :claimable')

    return entityManager
      .createQueryBuilder(Box, 'box')
      .select('box.id', 'id')
      .addSelect('box.updatedAt', 'updatedAt')
      .where('box.runnerId IN (:...runnerIds)', { runnerIds })
      .andWhere('box.state = :state', { state: BoxState.STOPPED })
      .andWhere('box.desiredState = :desiredState', { desiredState: BoxDesiredState.STOPPED })
      .andWhere('box.pending = false')
      .andWhere(`NOT EXISTS ${migrationInFlight.getQuery()}`)
      .setParameter('claimable', BoxMigrationState.COMPLETED)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getRawMany<ParkedBox>()
  }

  /**
   * Opens a migration on each locked box, on a copy of the stamp read under the
   * lock.
   *
   * The conflict guard is what a migration opened since the select survives: the
   * select's view of this table is a statement older than the lock, so a row
   * inserted in between is only visible here, and DO UPDATE takes over the
   * COMPLETED row a finished migration left while leaving a live one alone.
   *
   * @returns How many boxes got a migration — the rows the guard let through.
   */
  private async openMigrations(entityManager: EntityManager, parked: ParkedBox[]): Promise<number> {
    // ON CONFLICT names the row already there by the table's own name, and the
    // guard is written against that name by hand: an object-form condition is
    // built against the builder's alias for the target instead, which is the
    // entity's table path — under a non-default schema that is quoted whole,
    // as "schema.box_migration", a table no clause of the statement has.
    const conflictTarget = entityManager.connection.getMetadata(BoxMigration).tableName

    const claimed = await entityManager
      .createQueryBuilder()
      .insert()
      .into(BoxMigration)
      .values(
        parked.map(({ id, updatedAt }) => ({
          boxId: id,
          state: BoxMigrationState.PENDING_EXPORT,
          updatedAt,
        })),
      )
      .orUpdate(['state', 'updatedAt'], ['boxId'], {
        overwriteCondition: {
          where: `"${conflictTarget}"."state" = :claimable`,
          parameters: { claimable: BoxMigrationState.COMPLETED },
        },
      })
      .returning('"boxId"')
      .execute()

    return (claimed.raw as Array<{ boxId: string }>).length
  }

  /**
   * Upserts the last activity for a box.
   */
  private async upsertLastActivity(entityManager: EntityManager, boxId: string, lastActivityAt: Date): Promise<void> {
    await entityManager.upsert(BoxLastActivity, { boxId, lastActivityAt }, ['boxId'])
  }

  /**
   * Invalidates the box lookup cache for the inserted box.
   */
  private invalidateLookupCacheOnInsert(box: Box): void {
    try {
      this.boxLookupCacheInvalidationService.invalidateOrgId({
        id: box.id,
        organizationId: box.organizationId,
        name: box.name,
      })
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue box lookup cache invalidation on insert (id, organizationId, name) for ${box.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Invalidates the box lookup cache for the updated box.
   */
  private invalidateLookupCacheOnUpdate(
    updatedBox: Box,
    previousBox: Pick<Box, 'organizationId' | 'name' | 'authToken'>,
  ): void {
    try {
      this.boxLookupCacheInvalidationService.invalidate({
        id: updatedBox.id,
        organizationId: updatedBox.organizationId,
        previousOrganizationId: previousBox.organizationId,
        name: updatedBox.name,
        previousName: previousBox.name,
      })
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue box lookup cache invalidation on update (id, organizationId, name) for ${updatedBox.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    try {
      if (updatedBox.authToken !== previousBox.authToken) {
        this.boxLookupCacheInvalidationService.invalidate({
          authToken: updatedBox.authToken,
        })
      }
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue box lookup cache invalidation on update (authToken) for ${updatedBox.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Emits events based on the changes made to a box.
   */
  private emitUpdateEvents(
    updatedBox: Box,
    previousBox: Pick<Box, 'state' | 'desiredState' | 'public' | 'organizationId'>,
  ): void {
    if (previousBox.state !== updatedBox.state) {
      this.eventEmitter.emit(
        BoxEvents.STATE_UPDATED,
        new BoxStateUpdatedEvent(updatedBox, previousBox.state, updatedBox.state),
      )
    }

    if (previousBox.desiredState !== updatedBox.desiredState) {
      this.eventEmitter.emit(
        BoxEvents.DESIRED_STATE_UPDATED,
        new BoxDesiredStateUpdatedEvent(updatedBox, previousBox.desiredState, updatedBox.desiredState),
      )
    }

    if (previousBox.public !== updatedBox.public) {
      this.eventEmitter.emit(
        BoxEvents.PUBLIC_STATUS_UPDATED,
        new BoxPublicStatusUpdatedEvent(updatedBox, previousBox.public, updatedBox.public),
      )
    }

    if (previousBox.organizationId !== updatedBox.organizationId) {
      this.eventEmitter.emit(
        BoxEvents.ORGANIZATION_UPDATED,
        new BoxOrganizationUpdatedEvent(updatedBox, previousBox.organizationId, updatedBox.organizationId),
      )
    }
  }
}
