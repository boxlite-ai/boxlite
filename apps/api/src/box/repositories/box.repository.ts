/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomInt } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { DataSource, EntityManager, FindOneOptions, FindOptionsWhere, In, Not } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { BoxMigration } from '../entities/box-migration.entity'
import { Checkpoint } from '../entities/checkpoint.entity'
import { CheckpointOperation } from '../entities/checkpoint-operation.entity'
import { BoxCheckpointState } from '../entities/box-checkpoint-state.entity'
import { BoxState } from '../enums/box-state.enum'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxMigrationState } from '../enums/box-migration-state.enum'
import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common'
import { BoxConflictError } from '../errors/box-conflict.error'
import { InjectDataSource } from '@nestjs/typeorm'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { BaseRepository } from '../../common/repositories/base.repository'
import { BoxEvents } from '../constants/box-events.constants'
import { BoxStateUpdatedEvent } from '../events/box-state-updated.event'
import { BoxDesiredStateUpdatedEvent } from '../events/box-desired-state-updated.event'
import { BoxInboundModeUpdatedEvent } from '../events/box-inbound-mode-updated.event'
import { BoxOrganizationUpdatedEvent } from '../events/box-organization-updated.event'
import { BoxLookupCacheInvalidationService } from '../services/box-lookup-cache-invalidation.service'
import { BoxCreationAdmissionUnavailableError, BoxCreationLimitExceededError } from '../errors/box-creation-limit.error'
import { RegistryCredential } from '../../registry/entities/registry-credential.entity'
import { registryProxyHost } from '../../registry/utils/registry-proxy.util'
import { matchingCredential } from '../../registry/utils/matching-credential'
import { parseImageRef, upstreamRefOf } from '../../image/utils/image-ref.util'
import { OutboundPolicy } from '../runner-adapter/network-policy'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../constants/box.constants'
import { TypedConfigService } from '../../config/typed-config.service'
import type { BoxCreationQuotaService } from '../services/box-creation-quota.service'

// SQLSTATE lock_not_available — a statement waited longer than lock_timeout to
// acquire a lock.
const PG_LOCK_TIMEOUT_CODE = '55P03'

// Cap how long the proxy auto-start UPDATE waits to acquire the box row's
// write lock. Concurrent start/stop/sync go through updateWhere(), which holds
// a pessimistic_write lock on the same row; there is no global statement/lock
// timeout configured (see app.module.ts datasource `extra`), so without this
// bound a contended row could pin a pooled connection indefinitely. On timeout
// Postgres aborts the statement with SQLSTATE 55P03 and we treat it as a
// race-lost no-op. Aligned with the caller-side wait cap in
// boxlite-proxy.controller.ts (PROXY_START_HINT_TIMEOUT_MS).
const PROXY_START_LOCK_TIMEOUT_MS = 2000

const CREATION_ADMISSION_LOCK_TIMEOUT_MS = 5000
const CREATION_ADMISSION_RETRY_AFTER_SECONDS = 5

// Cross-version protocol: the original two-int key is the shared/exclusive
// compatibility barrier. Parallel releases must share the same lane keys and count.
export const CREATION_ADMISSION_LOCK_NAMESPACE = 0x424f5841 // 'BOXA'
const CREATION_ADMISSION_FIRST_LANE_NAMESPACE = 0x43525000
const CREATION_ADMISSION_LANES = 8

// Facts updates hold an organization's facts row for one short statement, so a
// longer wait means something else holds it. The Box write has already
// committed; give up on the best-effort update rather than delay its response.
const ORGANIZATION_ACTIVITY_LOCK_TIMEOUT_MS = 1000

export const BOX_CREATION_LIMIT_EXCLUDED_STATES = [
  BoxState.ERROR,
  BoxState.DESTROYING,
  BoxState.DESTROYED,
  BoxState.ARCHIVING,
  BoxState.ARCHIVED,
]

// A box the migration marker may claim, with the stamp its claim copies.
type ParkedBox = { id: string; updatedAt: Date }

// The fields of a Box before a write that decide its organization's activity.
type OrganizationActivitySource = Pick<Box, 'organizationId' | 'state' | 'desiredState' | 'createdAt'>
type OrganizationActivity = { createdAt: Date | null; modifiedAt: Date | null }
type AdmissionLockBudget = { remainingMs: number }

@Injectable()
export class BoxRepository extends BaseRepository<Box> {
  private readonly logger = new Logger(BoxRepository.name)

  /** Bound background lookups without inheriting waits from the query cache. */
  async findOne({ lockTimeoutMs, ...options }: FindOneOptions<Box> & { lockTimeoutMs?: number }): Promise<Box | null> {
    if (lockTimeoutMs === undefined) return super.findOne(options)
    return this.manager.transaction(async (manager) => {
      await manager.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`])
      return manager.findOne(Box, { ...options, cache: false })
    })
  }

  /** Read stable stop candidates without waiting indefinitely on a table lock. */
  async findRunningForStop(organizationIds: string[]): Promise<Pick<Box, 'id' | 'organizationId' | 'createdAt'>[]> {
    return this.manager.transaction(async (manager) => {
      await manager.query("SELECT set_config('lock_timeout', $1, true)", ['500ms'])
      return manager.find(Box, {
        where: {
          state: BoxState.STARTED,
          desiredState: BoxDesiredState.STARTED,
          pending: false,
          organizationId: In(organizationIds),
        },
        select: { id: true, organizationId: true, createdAt: true },
        order: { createdAt: 'ASC', id: 'ASC' },
      })
    })
  }

  /** Serialize runtime application and persistence against concurrent box writes. */
  async replaceOutbound(
    id: string,
    organizationId: string,
    policy: OutboundPolicy,
    apply: (box: Box, policy: OutboundPolicy) => Promise<void>,
  ): Promise<Box> {
    const updated = await this.manager.transaction(async (manager) => {
      await manager.query("SET LOCAL lock_timeout = '5s'")
      const box = await manager.findOne(Box, {
        where: { id, organizationId },
        lock: { mode: 'pessimistic_write' },
        loadEagerRelations: false,
      })
      if (!box) throw new NotFoundException('Box not found')
      if (box.state !== BoxState.STARTED || box.desiredState !== BoxDesiredState.STARTED || !box.runnerId) {
        throw new ConflictException('Outbound policy updates require a running box')
      }
      const previous: OutboundPolicy = {
        mode: box.outboundEnabled ? 'enabled' : 'disabled',
        allow_net: box.outboundAllowNet ?? [],
      }
      await apply(box, policy)
      const update = {
        outboundEnabled: policy.mode === 'enabled',
        outboundAllowNet: policy.allow_net.length ? policy.allow_net : null,
      }
      try {
        await manager.update(Box, id, update)
      } catch (error) {
        try {
          await apply(box, previous)
        } catch {
          throw new ConflictException(
            'Outbound persistence and rollback failed; live policy is uncertain, retry the complete update',
          )
        }
        throw error
      }
      Object.assign(box, update)
      return box
    })
    this.invalidateLookupCacheOnUpdate(updated, updated)
    return updated
  }

  constructor(
    @InjectDataSource() dataSource: DataSource,
    eventEmitter: EventEmitter2,
    private readonly boxLookupCacheInvalidationService: BoxLookupCacheInvalidationService,
    @Optional() private readonly configService?: TypedConfigService,
    private readonly creationQuota?: BoxCreationQuotaService,
  ) {
    super(dataSource, eventEmitter, Box)
  }

  async insert(
    box: Box,
    maxCreatedBoxes?: number,
    onPersist?: (manager: EntityManager, box: Box) => Promise<void>,
    initialize?: (manager: EntityManager) => Promise<void>,
    afterInsert?: (manager: EntityManager) => Promise<void>,
  ): Promise<Box> {
    const now = new Date()
    if (!box.createdAt) {
      box.createdAt = now
    }
    if (!box.updatedAt) {
      box.updatedAt = now
    }

    box.assertValid()
    box.enforceInvariants()

    await this.withCreationAdmission(
      box.organizationId,
      box.id,
      maxCreatedBoxes,
      async (entityManager) => {
        // Provisioning work and ownership must commit with the new Box. Run
        // initialization before insertion so checkpoint use can hold its row lock.
        await initialize?.(entityManager)
        await this.lockRegistryCredential(box, entityManager)
        await entityManager.insert(Box, box)
        // Resource ownership and admission must commit with the Box itself.
        await onPersist?.(entityManager, box)
        await afterInsert?.(entityManager)
        await this.upsertLastActivity(entityManager, box.id, box.createdAt)
      },
      onPersist === undefined && initialize === undefined && afterInsert === undefined,
    )
    if (maxCreatedBoxes === undefined && this.creationQuota?.enabled) {
      void this.creationQuota.trackCommitted(box.organizationId, box.id)
    }

    this.invalidateLookupCacheOnInsert(box)
    await this.afterBoxWrite(box)

    return box
  }

  private async lockRegistryCredential(box: Box, manager: EntityManager): Promise<void> {
    const proxy = registryProxyHost()
    if (!proxy || !box.image?.startsWith(`${proxy}/${box.organizationId}/`)) return

    const { host, repository } = parseImageRef(upstreamRefOf(box.image))
    try {
      // Shared until the box commits: deletion cannot pass its dependency
      // check while this box is still invisible to other transactions.
      const credentials = await manager
        .getRepository(RegistryCredential)
        .createQueryBuilder('credential')
        .where('credential.organizationId = :organizationId', { organizationId: box.organizationId })
        .andWhere('credential.registryHost = :host', { host })
        .setLock('pessimistic_read')
        .setOnLocked('nowait')
        .getMany()
      if (!matchingCredential(credentials, repository)) {
        throw new ConflictException('Registry credential was removed during box creation; retry the request')
      }
    } catch (error) {
      if ((error as { code?: string }).code === PG_LOCK_TIMEOUT_CODE) {
        throw new ConflictException('Registry credential is being removed; retry box creation')
      }
      throw error
    }
  }

  /**
   * @param id - The ID of the box to update.
   * @param params.updateData - The partial data to update.
   *
   * @returns `void` because a raw update is performed.
   */
  async update(id: string, params: { updateData: Partial<Box>; maxCreatedBoxes?: number }, raw: true): Promise<void>
  /**
   * @param id - The ID of the box to update.
   * @param params.updateData - The partial data to update.
   * @param params.entity - Optional pre-fetched box to use instead of fetching from the database.
   *
   * @returns The updated box.
   */
  async update(
    id: string,
    params: { updateData: Partial<Box>; entity?: Box; maxCreatedBoxes?: number },
    raw?: false,
  ): Promise<Box>
  async update(
    id: string,
    params: { updateData: Partial<Box>; entity?: Box; maxCreatedBoxes?: number },
    raw = false,
  ): Promise<Box | void> {
    const { updateData, entity, maxCreatedBoxes } = params

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

    await this.withCreationAdmission(box.organizationId, box.id, maxCreatedBoxes, async (entityManager) => {
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
    await this.afterBoxWrite(box, previousBox)

    return box
  }

  private async withCreationAdmission(
    organizationId: string,
    boxId: string,
    maxCreatedBoxes: number | undefined,
    persist: (entityManager: EntityManager) => Promise<void>,
    singleInsertWithoutCallbacks = false,
  ): Promise<void> {
    if (maxCreatedBoxes === undefined) {
      return this.dataSource.transaction(persist)
    }
    if (this.creationQuota?.enabled) {
      return this.creationQuota.run(organizationId, boxId, maxCreatedBoxes, persist)
    }

    const budget = { remainingMs: CREATION_ADMISSION_LOCK_TIMEOUT_MS }
    if (
      singleInsertWithoutCallbacks &&
      Number.isSafeInteger(maxCreatedBoxes) &&
      maxCreatedBoxes >= CREATION_ADMISSION_LANES
    ) {
      const laneNamespace = CREATION_ADMISSION_FIRST_LANE_NAMESPACE + randomInt(CREATION_ADMISSION_LANES)
      const admitted = await this.dataSource.transaction('READ COMMITTED', async (manager) => {
        // Take the lane first so lane waiters do not hold the shared barrier.
        await this.acquireCreationAdmissionLock(manager, organizationId, budget, laneNamespace)
        await this.acquireCreationAdmissionLock(
          manager,
          organizationId,
          budget,
          CREATION_ADMISSION_LOCK_NAMESPACE,
          'shared',
        )
        const currentCount = await this.countForCreationAdmission(manager, organizationId)
        if (!this.hasParallelCreationHeadroom(currentCount, maxCreatedBoxes)) return false
        await persist(manager)
        return true
      })
      if (admitted) return
      // The no-write transaction has released its locks and connection. Take
      // the exclusive key in a new transaction, never upgrade it in place.
    }

    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.acquireCreationAdmissionLock(manager, organizationId, budget)
      const currentCount = await this.countForCreationAdmission(manager, organizationId)
      if (currentCount >= maxCreatedBoxes) {
        throw new BoxCreationLimitExceededError(currentCount, maxCreatedBoxes)
      }
      return persist(manager)
    })
  }

  private countForCreationAdmission(manager: EntityManager, organizationId: string): Promise<number> {
    // A separate READ COMMITTED statement sees commits made before lock grant.
    return manager.count(Box, { where: { organizationId, state: Not(In(BOX_CREATION_LIMIT_EXCLUDED_STATES)) } })
  }

  private hasParallelCreationHeadroom(count: number, max: number): boolean {
    // At the count snapshot, other admitted inserts not yet visible still hold
    // their lanes: PostgreSQL makes a commit visible before releasing its lane.
    // Including this insert, at most eight slots are needed beyond the count.
    // This checks the request's resolved limit at admission, not at commit.
    return Number.isSafeInteger(count) && count >= 0 && count <= max - CREATION_ADMISSION_LANES
  }

  /** Read lifecycle state and ownership in one snapshot, without changing ordinary Box projections. */
  async findWithCheckpointState(
    id: string,
    organizationId?: string,
  ): Promise<{ box: Box; checkpointState: BoxCheckpointState | null }> {
    const { entities, raw } = await this.repository
      .createQueryBuilder('box')
      .leftJoin(BoxCheckpointState, 'checkpoint', 'checkpoint.boxId = box.id')
      .addSelect('checkpoint.activeJobId', 'checkpoint_job_id')
      .addSelect('checkpoint.sequence', 'checkpoint_sequence')
      .where({ id, ...(organizationId === undefined ? {} : { organizationId }) })
      .getRawAndEntities<{ checkpoint_job_id: string | null; checkpoint_sequence: number | null }>()
    const box = entities[0]
    if (!box) throw new NotFoundException('Box not found')
    const checkpointState =
      raw[0].checkpoint_sequence === null
        ? null
        : { boxId: id, activeJobId: raw[0].checkpoint_job_id, sequence: raw[0].checkpoint_sequence }
    return { box, checkpointState }
  }

  async findWithCheckpointStateForLifecycle(
    idOrName: string,
    organizationId: string | undefined,
    lookup: 'id' | 'id-or-name',
  ): Promise<{ box: Box; checkpointState: BoxCheckpointState | null }> {
    if (lookup === 'id' && !organizationId) throw new NotFoundException(`Box with ID ${idOrName} not found`)
    const organization = organizationId ? { organizationId } : {}
    const state = { state: Not(BoxState.DESTROYED) }
    const find = (where: FindOptionsWhere<Box>) =>
      this.repository
        .createQueryBuilder('box')
        .leftJoin(BoxCheckpointState, 'checkpoint', 'checkpoint.boxId = box.id')
        .addSelect('checkpoint.activeJobId', 'checkpoint_job_id')
        .addSelect('checkpoint.sequence', 'checkpoint_sequence')
        .where(where)
        .getRawAndEntities<{ checkpoint_job_id: string | null; checkpoint_sequence: number | null }>()

    let { entities, raw } = await find({ id: idOrName, ...organization, ...state })
    if (!entities[0] && lookup === 'id-or-name') {
      ;({ entities, raw } = await find({ name: idOrName, ...organization, ...state }))
    }
    const box = entities[0]
    if (
      !box ||
      (lookup === 'id-or-name' && box.state === BoxState.ERROR && box.desiredState === BoxDesiredState.DESTROYED)
    ) {
      throw new NotFoundException(`Box with ID or name ${idOrName} not found`)
    }
    const checkpointState =
      raw[0].checkpoint_sequence === null
        ? null
        : { boxId: box.id, activeJobId: raw[0].checkpoint_job_id, sequence: raw[0].checkpoint_sequence }
    return { box, checkpointState }
  }

  /** Explicit deletion fences checkpoint callbacks before the runner removes the target. */
  async deleteCheckpointTarget(selected: Box, selectedState: BoxCheckpointState): Promise<Box> {
    if (!selectedState.activeJobId) throw new ConflictException('Box has no checkpoint operation')
    const pending = await this.manager.findOneBy(CheckpointOperation, {
      boxId: selected.id,
      organizationId: selected.organizationId,
      jobId: selectedState.activeJobId,
    })
    if (!pending) throw new ConflictException('Box has another state change in progress')
    const changed = await this.dataSource.transaction(async (manager) => {
      // Match checkpoint use/deletion and receipt processing: checkpoint first.
      await manager.findOne(Checkpoint, {
        where: { id: pending.checkpointId, organizationId: selected.organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      const box = await manager.findOne(Box, {
        where: { id: selected.id, organizationId: selected.organizationId },
        lock: { mode: 'pessimistic_write' },
      })
      const checkpointState = await manager.findOne(BoxCheckpointState, {
        where: { boxId: selected.id },
        lock: { mode: 'pessimistic_write' },
      })
      if (
        !box ||
        !checkpointState ||
        checkpointState.activeJobId !== pending.jobId ||
        checkpointState.sequence !== pending.sequence ||
        checkpointState.sequence !== selectedState.sequence
      )
        throw new ConflictException('Checkpoint operation changed; retry Box deletion')
      const previous = { ...box }
      const operation = await manager.findOne(CheckpointOperation, {
        where: { id: pending.id, jobId: checkpointState.activeJobId, state: In(['pending', 'failed']) },
        lock: { mode: 'pessimistic_write' },
      })
      if (!operation) throw new ConflictException('Checkpoint operation changed; retry Box deletion')
      operation.state = 'cancelled'
      await manager.save(CheckpointOperation, operation)
      checkpointState.activeJobId = null
      checkpointState.sequence += 1
      await manager.save(BoxCheckpointState, checkpointState)
      Object.assign(box, Box.getSoftDeleteUpdate(box), {
        state: BoxState.ERROR,
        recoverable: false,
        errorReason: 'Checkpoint operation cancelled for Box deletion',
      })
      box.assertValid()
      box.enforceInvariants()
      await manager.save(Box, box)
      await manager.query('DELETE FROM secret_credential WHERE box_id = $1', [box.id])
      return { box, previous }
    })
    this.emitUpdateEvents(changed.box, changed.previous)
    this.invalidateLookupCacheOnUpdate(changed.box, changed.previous)
    await this.afterBoxWrite(changed.box, changed.previous)
    return changed.box
  }

  // One statement sets the wait cap, takes the lock, and restores the default,
  // so only this lock wait can raise the admission 503. This relies on
  // PostgreSQL evaluating select-list entries in order (ExecBuildProjectionInfo
  // in src/backend/executor/execExpr.c); the docs leave expression order
  // unspecified, so the real-Postgres integration spec checks both halves.
  private async acquireCreationAdmissionLock(
    manager: EntityManager,
    organizationId: string,
    budget: AdmissionLockBudget,
    namespace = CREATION_ADMISSION_LOCK_NAMESPACE,
    mode: 'exclusive' | 'shared' = 'exclusive',
  ): Promise<void> {
    const timeoutMs = Math.ceil(budget.remainingMs)
    if (timeoutMs > 0) {
      const lock = mode === 'shared' ? 'pg_advisory_xact_lock_shared' : 'pg_advisory_xact_lock'
      const startedAt = performance.now()
      try {
        await manager.query(
          `SELECT set_config('lock_timeout', $1, true),
                  ${lock}($2, hashtext($3)),
                  set_config('lock_timeout', (SELECT reset_val FROM pg_settings WHERE name = 'lock_timeout'), true)`,
          [`${timeoutMs}ms`, namespace, organizationId],
        )
        return
      } catch (error) {
        if ((error as { code?: string }).code !== PG_LOCK_TIMEOUT_CODE) throw error
      } finally {
        // Share the budget across lock queries, not pool checkout, count or persist.
        budget.remainingMs -= performance.now() - startedAt
      }
    }
    throw new BoxCreationAdmissionUnavailableError(
      'Box creation admission remained contended; retry the request',
      CREATION_ADMISSION_RETRY_AFTER_SECONDS,
    )
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
      lockTimeoutMs?: number
    },
  ): Promise<Box> {
    const { updateData, whereCondition, lockTimeoutMs } = params

    const [updatedBox, previousBox] = await this.manager.transaction(async (entityManager) => {
      if (lockTimeoutMs !== undefined) {
        await entityManager.query("SELECT set_config('lock_timeout', $1, true)", [`${lockTimeoutMs}ms`])
      }
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
      if (box.desiredState === BoxDesiredState.DESTROYED) {
        await entityManager.query('DELETE FROM secret_credential WHERE box_id = $1', [id])
      }
      box.updatedAt = new Date()

      if (previousBox.state !== box.state || previousBox.organizationId !== box.organizationId) {
        await this.upsertLastActivity(entityManager, id, box.updatedAt)
      }

      this.emitUpdateEvents(box, previousBox)
      this.invalidateLookupCacheOnUpdate(box, previousBox)

      return [box, previousBox] as const
    })

    await this.afterBoxWrite(updatedBox, previousBox)
    return updatedBox
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

  private afterBoxWrite(box: Box, previousBox?: OrganizationActivitySource): Promise<void> {
    const asynchronous = this.configService?.get('boxSync.organizationActivityAsync') !== false
    const recording = this.recordOrganizationActivity(box, previousBox, asynchronous)
    if (!asynchronous) return recording
    void recording
    return Promise.resolve()
  }

  /**
   * Advances activation facts after the Box commits. GREATEST keeps late and
   * concurrent retries monotonic. Three attempts bound transient-lock recovery;
   * a final failure or process exit may lose this best-effort activity update.
   */
  private async recordOrganizationActivity(
    box: Box,
    previousBox?: OrganizationActivitySource,
    retry = true,
  ): Promise<void> {
    let activity: OrganizationActivity | null
    try {
      activity = this.organizationActivityOf(box, previousBox)
    } catch (error) {
      this.logger.warn(
        `Failed to record activity of box ${box.id} for organization ${box.organizationId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }
    if (!activity) return

    const maxAttempts = retry ? 3 : 1
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await this.manager.transaction(async (entityManager) => {
          // SET takes a literal, so the constant is interpolated rather than bound.
          await entityManager.query(`SET LOCAL lock_timeout = '${ORGANIZATION_ACTIVITY_LOCK_TIMEOUT_MS}ms'`)
          await entityManager.query(
            `INSERT INTO organization_activation_facts AS facts ("organizationId", "lastBoxCreatedAt", "lastBoxModifiedAt")
             VALUES ($1::uuid, $2::timestamptz, $3::timestamptz)
             ON CONFLICT ("organizationId") DO UPDATE
             SET "lastBoxCreatedAt" = GREATEST(facts."lastBoxCreatedAt", EXCLUDED."lastBoxCreatedAt"),
               "lastBoxModifiedAt" = GREATEST(facts."lastBoxModifiedAt", EXCLUDED."lastBoxModifiedAt")
             WHERE facts."lastBoxCreatedAt" IS DISTINCT FROM GREATEST(facts."lastBoxCreatedAt", EXCLUDED."lastBoxCreatedAt")
               OR facts."lastBoxModifiedAt" IS DISTINCT FROM GREATEST(facts."lastBoxModifiedAt", EXCLUDED."lastBoxModifiedAt")`,
            [box.organizationId, activity.createdAt, activity.modifiedAt],
          )
        })
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt === maxAttempts - 1) {
          this.logger.error({
            event: 'organization.activity.dropped',
            boxId: box.id,
            organizationId: box.organizationId,
            attempt: maxAttempts,
            error: message,
          })
        } else {
          this.logger.warn(
            `Failed to record activity of box ${box.id} for organization ${box.organizationId}: ${message}`,
          )
        }
        if (attempt < maxAttempts - 1) {
          const delay = 100 * 2 ** attempt + randomInt(100)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay)
            timer.unref()
          })
        }
      }
    }
  }

  /**
   * What a committed Box write contributes to its organization's facts, or null.
   *
   * Creation counts inserts and warm-pool claims; modification counts entering
   * `started` and the first deletion request. Stops, label edits, repeated
   * states, deletion completion and cleanup contribute nothing. Lifecycle times
   * moved between real organizations stay with the source.
   */
  private organizationActivityOf(box: Box, previousBox?: OrganizationActivitySource): OrganizationActivity | null {
    if (box.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
      return null
    }
    if (!previousBox) {
      return { createdAt: box.createdAt, modifiedAt: null }
    }
    if (previousBox.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
      const claimKeptPoolCreation = box.createdAt.getTime() === previousBox.createdAt.getTime()
      return {
        createdAt: claimKeptPoolCreation ? box.updatedAt : box.createdAt,
        modifiedAt: box.state === BoxState.STARTED ? box.updatedAt : null,
      }
    }
    if (previousBox.organizationId !== box.organizationId) {
      return null
    }
    const started = box.state === BoxState.STARTED && previousBox.state !== BoxState.STARTED
    const deletionRequested =
      box.desiredState === BoxDesiredState.DESTROYED && previousBox.desiredState !== BoxDesiredState.DESTROYED
    return started || deletionRequested ? { createdAt: null, modifiedAt: box.updatedAt } : null
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
    previousBox: Pick<Box, 'state' | 'desiredState' | 'inboundEnabled' | 'organizationId'>,
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

    if (previousBox.inboundEnabled !== updatedBox.inboundEnabled) {
      this.eventEmitter.emit(
        BoxEvents.INBOUND_MODE_UPDATED,
        new BoxInboundModeUpdatedEvent(updatedBox, previousBox.inboundEnabled, updatedBox.inboundEnabled),
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
