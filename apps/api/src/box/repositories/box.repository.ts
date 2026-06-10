/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DataSource, EntityManager, FindOptionsWhere } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
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
        boxId: box.boxId,
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
    previousBox: Pick<Box, 'organizationId' | 'boxId' | 'name' | 'authToken'>,
  ): void {
    try {
      this.boxLookupCacheInvalidationService.invalidate({
        id: updatedBox.id,
        boxId: updatedBox.boxId,
        organizationId: updatedBox.organizationId,
        previousOrganizationId: previousBox.organizationId,
        previousBoxId: previousBox.boxId,
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
