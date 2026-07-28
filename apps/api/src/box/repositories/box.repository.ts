/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DataSource, EntityManager, FindOptionsWhere } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
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
import { UsagePeriodWriter } from '../../usage/metering/usage-period-writer'

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

const METERING_FIELDS = new Set<keyof Box>([
  'state',
  'desiredState',
  'organizationId',
  'cpu',
  'gpu',
  'mem',
  'disk',
  'region',
  'class',
  'runtimeGeneration',
  'runtimeAuthorized',
  'runtimeUnavailable',
])

@Injectable()
export class BoxRepository extends BaseRepository<Box> {
  private readonly logger = new Logger(BoxRepository.name)

  constructor(
    @InjectDataSource() dataSource: DataSource,
    eventEmitter: EventEmitter2,
    private readonly boxLookupCacheInvalidationService: BoxLookupCacheInvalidationService,
    private readonly usagePeriodWriter: UsagePeriodWriter,
  ) {
    super(dataSource, eventEmitter, Box)
  }

  async insert(box: Box): Promise<Box> {
    box.assertValid()
    box.enforceInvariants()

    await this.dataSource.transaction(async (entityManager) => {
      const transitionAt = await this.databaseNow(entityManager)
      box.createdAt ??= transitionAt
      box.updatedAt ??= transitionAt
      await entityManager.insert(Box, box)
      await this.usagePeriodWriter.transition({
        manager: entityManager,
        previousBox: null,
        currentBox: box,
        transitionAt,
      })
      await this.upsertLastActivity(entityManager, box.id, transitionAt)
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
      this.assertRawUpdateIsNotMeteringRelevant(updateData)
      await this.repository.update(id, updateData)
      return
    }

    const result = await this.dataSource.transaction(async (entityManager) => {
      const persistedBox = await entityManager.findOne(Box, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
        relations: [],
        loadEagerRelations: false,
      })
      if (!persistedBox) {
        throw new NotFoundException('Box not found')
      }
      if (entity && !this.sameConcurrencySnapshot(entity, persistedBox, updateData)) {
        throw new BoxConflictError()
      }

      const previousBox = { ...persistedBox } as Box
      Object.assign(persistedBox, updateData)
      persistedBox.assertValid()
      const invariantChanges = persistedBox.enforceInvariants()
      const transitionAt = await this.databaseNow(entityManager)
      persistedBox.updatedAt = transitionAt

      await entityManager.update(Box, id, { ...updateData, ...invariantChanges, updatedAt: transitionAt })
      await this.usagePeriodWriter.transition({
        manager: entityManager,
        previousBox,
        currentBox: persistedBox,
        transitionAt,
      })

      if (previousBox.state !== persistedBox.state || previousBox.organizationId !== persistedBox.organizationId) {
        await this.upsertLastActivity(entityManager, id, transitionAt)
      }

      return { box: persistedBox, previousBox }
    })

    const updatedBox = entity ? Object.assign(entity, result.box) : result.box
    this.emitUpdateEvents(updatedBox, result.previousBox)
    this.invalidateLookupCacheOnUpdate(updatedBox, result.previousBox)

    return updatedBox
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

    const result = await this.manager.transaction(async (entityManager) => {
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

      const previousBox = { ...box } as Box

      Object.assign(box, updateData)
      box.assertValid()
      const invariantChanges = box.enforceInvariants()
      const transitionAt = await this.databaseNow(entityManager)
      box.updatedAt = transitionAt

      await entityManager.update(Box, id, { ...updateData, ...invariantChanges, updatedAt: transitionAt })
      await this.usagePeriodWriter.transition({
        manager: entityManager,
        previousBox,
        currentBox: box,
        transitionAt,
      })

      if (previousBox.state !== box.state || previousBox.organizationId !== box.organizationId) {
        await this.upsertLastActivity(entityManager, id, transitionAt)
      }

      return { box, previousBox }
    })

    this.emitUpdateEvents(result.box, result.previousBox)
    this.invalidateLookupCacheOnUpdate(result.box, result.previousBox)

    return result.box
  }

  /**
   * Conditionally transitions a stable stopped Box into a start intent.
   * @throws DB errors other than lock-timeout (not wrapped) — caller decides
   *   whether to swallow.
   */
  async conditionalStartForProxy(boxId: string, organizationId: string): Promise<Box | null> {
    try {
      const updatedBox = await this.manager.transaction(async (entityManager) => {
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
            updatedAt: () => 'clock_timestamp()',
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
        const transitionAt = updated.updatedAt
        const previousBox = entityManager.create(Box, {
          ...raw,
          pending: false,
          desiredState: BoxDesiredState.STOPPED,
        })

        await this.usagePeriodWriter.transition({
          manager: entityManager,
          previousBox,
          currentBox: updated,
          transitionAt,
        })

        // id / name / org haven't changed, but the cached entity snapshot still
        // holds the old desiredState/pending — invalidate so subsequent
        // findOneByIdOrName fetches fresh values.
        return updated
      })

      if (updatedBox) {
        this.invalidateLookupCacheOnUpdate(updatedBox, {
          organizationId: updatedBox.organizationId,
          name: updatedBox.name,
          authToken: updatedBox.authToken,
        })
      }

      return updatedBox
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
   * Upserts the last activity for a box.
   */
  private async upsertLastActivity(entityManager: EntityManager, boxId: string, lastActivityAt: Date): Promise<void> {
    await entityManager.upsert(BoxLastActivity, { boxId, lastActivityAt }, ['boxId'])
  }

  private assertRawUpdateIsNotMeteringRelevant(updateData: Partial<Box>): void {
    const forbiddenField = (Object.keys(updateData) as (keyof Box)[]).find((field) => METERING_FIELDS.has(field))
    if (forbiddenField) {
      throw new Error(`Raw Box update cannot modify metering field '${String(forbiddenField)}'`)
    }
  }

  private sameConcurrencySnapshot(snapshot: Box, persisted: Box, updateData: Partial<Box>): boolean {
    const ownsLifecycleJob = Object.prototype.hasOwnProperty.call(updateData, 'lifecycleJobId')
    return (
      snapshot.state === persisted.state &&
      snapshot.desiredState === persisted.desiredState &&
      snapshot.pending === persisted.pending &&
      snapshot.organizationId === persisted.organizationId &&
      snapshot.cpu === persisted.cpu &&
      snapshot.gpu === persisted.gpu &&
      snapshot.mem === persisted.mem &&
      snapshot.disk === persisted.disk &&
      snapshot.region === persisted.region &&
      snapshot.class === persisted.class &&
      snapshot.runtimeGeneration === persisted.runtimeGeneration &&
      snapshot.runtimeAuthorized === persisted.runtimeAuthorized &&
      snapshot.runtimeUnavailable === persisted.runtimeUnavailable &&
      (!ownsLifecycleJob || snapshot.lifecycleJobId === persisted.lifecycleJobId)
    )
  }

  private async databaseNow(entityManager: EntityManager): Promise<Date> {
    const [row] = await entityManager.query(`SELECT clock_timestamp() AS "now"`)
    return new Date(row.now)
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

  publishCommittedUpdate(
    updatedBox: Box,
    previousBox: Pick<Box, 'state' | 'desiredState' | 'public' | 'organizationId' | 'name' | 'authToken'>,
  ): void {
    this.invalidateLookupCacheOnUpdate(updatedBox, previousBox)
    this.emitUpdateEvents(updatedBox, previousBox)
  }
}
