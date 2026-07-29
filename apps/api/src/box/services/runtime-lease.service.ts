/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Inject, Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { DataSource, EntityManager, IsNull, LessThanOrEqual, Not } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { MeteringMode } from '../enums/metering-mode.enum'
import { RUNTIME_USAGE_SINK, RuntimeUsageSink } from './runtime-usage-sink'
import { BoxRuntimeCleanup } from '../entities/box-runtime-cleanup.entity'
import { BoxRuntimeLease } from '../entities/box-runtime-lease.entity'
import { BoxLastActivity } from '../entities/box-last-activity.entity'
import { Box } from '../entities/box.entity'
import { Job } from '../entities/job.entity'
import { RunnerRuntimeEpoch } from '../entities/runner-runtime-epoch.entity'
import { Runner } from '../entities/runner.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { BoxRepository } from '../repositories/box.repository'

const RUNTIME_UNAVAILABLE_REASON = 'Actual runtime lease expired or reported unavailable'
const SWEEP_BATCH_SIZE = 100
const RUNTIME_START_JOB_TYPES: ReadonlySet<JobType> = new Set([
  JobType.CREATE_BOX,
  JobType.START_BOX,
  JobType.RECOVER_BOX,
])
const AUTHORIZED_RUNNING_STATES: ReadonlySet<BoxState> = new Set([BoxState.STARTED, BoxState.RESIZING])

export interface RunnerBoxRuntimeObservation {
  boxId: string
  actualState: BoxState
  runtimeGeneration: number
}

export interface RunnerRuntimeSnapshot {
  runnerId: string
  runnerEpoch: string
  runnerIncarnation: number
  sequence: number
  boxes?: RunnerBoxRuntimeObservation[]
}

export interface RuntimeCleanupTarget {
  boxId: string
  runnerId: string
  runnerEpoch: string
  runtimeGeneration: number
}

export interface RuntimeLeaseSnapshot {
  boxId: string
  runnerEpoch: string
  runtimeGeneration: number
  sequence: number
  leaseExpiresAt: Date
}

export enum RuntimeStartFinalizationStatus {
  CONFIRMED = 'confirmed',
  WAITING = 'waiting',
  REJECTED = 'rejected',
  STALE = 'stale',
}

interface CommittedBoxChange {
  previousBox: Box
  currentBox: Box
}

interface RuntimeStartEvaluation {
  status: RuntimeStartFinalizationStatus
  box: Box | null
}

@Injectable()
export class RuntimeLeaseService {
  private readonly logger = new Logger(RuntimeLeaseService.name)

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: TypedConfigService,
    @Inject(RUNTIME_USAGE_SINK) private readonly usagePeriodWriter: RuntimeUsageSink,
    private readonly boxRepository: BoxRepository,
  ) {}

  async observeRunnerSnapshot(
    snapshot: RunnerRuntimeSnapshot,
  ): Promise<{ accepted: boolean; cleanupTargets: RuntimeCleanupTarget[] }> {
    const committedChanges: CommittedBoxChange[] = []
    const result = await this.dataSource.transaction(async (manager) => {
      const observedAt = await this.databaseNow(manager)
      const runner = await manager.findOne(Runner, {
        where: { id: snapshot.runnerId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!runner) {
        throw new Error(`Runner ${snapshot.runnerId} not found while recording runtime lease`)
      }

      if (!(await this.acceptRunnerEpoch(manager, runner, snapshot, observedAt))) {
        return { accepted: false, cleanupTargets: [] }
      }
      if (snapshot.boxes === undefined) {
        return { accepted: true, cleanupTargets: [] }
      }

      const observations = this.uniqueObservations(snapshot.boxes)
      const observedRuntimeKeys = new Set(
        observations.map((observation) => this.runtimeKey(observation.boxId, observation.runtimeGeneration)),
      )
      const cleanupTargets: RuntimeCleanupTarget[] = []
      for (const observation of observations) {
        const target = await this.applyObservation(manager, runner, snapshot, observation, observedAt, committedChanges)
        if (target && (await this.reserveCleanup(manager, target))) {
          cleanupTargets.push(target)
        }
      }
      const boxesRequiringProof = await manager.find(Box, {
        where: [
          { runnerId: runner.id, runtimeAuthorized: true },
          { runnerId: runner.id, lifecycleJobId: Not(IsNull()) },
        ],
      })
      for (const box of boxesRequiringProof) {
        if (
          box.runtimeGeneration <= 0 ||
          observedRuntimeKeys.has(this.runtimeKey(box.id, box.runtimeGeneration)) ||
          (!box.runtimeAuthorized && !(await this.hasMatchingStartJob(manager, box)))
        ) {
          continue
        }
        await this.applyObservation(
          manager,
          runner,
          snapshot,
          {
            boxId: box.id,
            actualState: BoxState.STOPPED,
            runtimeGeneration: box.runtimeGeneration,
          },
          observedAt,
          committedChanges,
        )
      }
      const previouslyRunningLeases = await manager.find(BoxRuntimeLease, {
        where: { runnerId: runner.id, actualState: BoxState.STARTED },
      })
      for (const lease of previouslyRunningLeases) {
        if (lease.runnerEpoch === snapshot.runnerEpoch && lease.sequence === snapshot.sequence) continue
        await this.applyObservation(
          manager,
          runner,
          snapshot,
          {
            boxId: lease.boxId,
            actualState: BoxState.STOPPED,
            runtimeGeneration: lease.runtimeGeneration,
          },
          observedAt,
          committedChanges,
        )
        await manager.update(
          BoxRuntimeLease,
          {
            boxId: lease.boxId,
            runnerId: lease.runnerId,
            runnerEpoch: lease.runnerEpoch,
            runtimeGeneration: lease.runtimeGeneration,
            sequence: lease.sequence,
            actualState: BoxState.STARTED,
          },
          {
            runnerEpoch: snapshot.runnerEpoch,
            sequence: snapshot.sequence,
            actualState: BoxState.UNKNOWN,
            observedAt,
            leaseExpiresAt: observedAt,
          },
        )
      }
      return { accepted: true, cleanupTargets }
    })

    for (const change of committedChanges) {
      this.boxRepository.publishCommittedUpdate(change.currentBox, change.previousBox)
    }
    return result
  }

  async finalizeStartedJob(job: Job): Promise<RuntimeStartFinalizationStatus> {
    let committedChange: CommittedBoxChange | null = null
    const status = await this.dataSource.transaction(async (manager) => {
      const now = await this.databaseNow(manager)
      const evaluation = await this.evaluateStartedJob(manager, job, now)
      if (!evaluation.box) {
        return evaluation.status
      }

      if (evaluation.status === RuntimeStartFinalizationStatus.CONFIRMED) {
        const result = job.getResultMetadata()
        const daemonVersion =
          typeof result?.daemonVersion === 'string' ? result.daemonVersion : evaluation.box.daemonVersion
        committedChange = await this.transitionRuntimeState(
          manager,
          evaluation.box,
          {
            state: BoxState.STARTED,
            pending: false,
            recoverable: false,
            runtimeAuthorized: true,
            runtimeUnavailable: false,
            errorReason: null,
            daemonVersion,
            lifecycleJobId: null,
          },
          now,
        )
      } else if (evaluation.status === RuntimeStartFinalizationStatus.REJECTED) {
        committedChange = await this.transitionRuntimeState(
          manager,
          evaluation.box,
          {
            state: BoxState.ERROR,
            pending: false,
            recoverable: true,
            runtimeAuthorized: false,
            runtimeUnavailable: true,
            errorReason: `Runtime confirmation expired or was contradicted for ${job.type} job ${job.id}`,
            lifecycleJobId: null,
          },
          now,
          MeteringMode.DISK_ONLY,
        )
      }
      return evaluation.status
    })

    if (committedChange) {
      this.boxRepository.publishCommittedUpdate(committedChange.currentBox, committedChange.previousBox)
    }
    return status
  }

  @Cron('*/10 * * * * *', { name: 'reconcile-expired-runtime-leases', waitForCompletion: true })
  async sweepExpiredLeases(): Promise<void> {
    const now = await this.dataSource.transaction((manager) => this.databaseNow(manager))
    const candidates = await this.dataSource.getRepository(BoxRuntimeLease).find({
      where: {
        actualState: BoxState.STARTED,
        leaseExpiresAt: LessThanOrEqual(now),
      },
      order: { leaseExpiresAt: 'ASC', boxId: 'ASC' },
      take: SWEEP_BATCH_SIZE,
    })

    for (const lease of candidates) {
      try {
        await this.reconcileExpiredCandidate(this.snapshotOf(lease))
      } catch (error) {
        this.logger.error(
          `Failed to reconcile expired runtime lease for Box ${lease.boxId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  async reconcileExpiredCandidate(candidate: RuntimeLeaseSnapshot): Promise<boolean> {
    let committedChange: CommittedBoxChange | null = null
    const reconciled = await this.dataSource.transaction(async (manager) => {
      const box = await manager.findOne(Box, {
        where: { id: candidate.boxId },
        lock: { mode: 'pessimistic_write' },
      })
      const lease = await manager.findOne(BoxRuntimeLease, {
        where: { boxId: candidate.boxId },
        lock: { mode: 'pessimistic_write' },
      })
      const now = await this.databaseNow(manager)
      if (
        !lease ||
        !this.matchesSnapshot(lease, candidate) ||
        lease.actualState !== BoxState.STARTED ||
        lease.leaseExpiresAt.getTime() > now.getTime()
      ) {
        return false
      }
      if (
        !box ||
        box.runnerId !== lease.runnerId ||
        box.runtimeGeneration !== lease.runtimeGeneration ||
        !box.runtimeAuthorized ||
        box.desiredState !== BoxDesiredState.STARTED ||
        !AUTHORIZED_RUNNING_STATES.has(box.state)
      ) {
        lease.actualState = BoxState.UNKNOWN
        await manager.save(BoxRuntimeLease, lease)
        return false
      }

      committedChange = await this.transitionRuntimeState(
        manager,
        box,
        {
          state: BoxState.ERROR,
          pending: false,
          recoverable: true,
          runtimeUnavailable: true,
          errorReason: RUNTIME_UNAVAILABLE_REASON,
        },
        now,
        MeteringMode.DISK_ONLY,
      )
      lease.actualState = BoxState.ERROR
      await manager.save(BoxRuntimeLease, lease)
      return true
    })

    if (committedChange) {
      this.boxRepository.publishCommittedUpdate(committedChange.currentBox, committedChange.previousBox)
    }
    return reconciled
  }

  private async applyObservation(
    manager: EntityManager,
    runner: Runner,
    snapshot: RunnerRuntimeSnapshot,
    observation: RunnerBoxRuntimeObservation,
    observedAt: Date,
    committedChanges: CommittedBoxChange[],
  ): Promise<RuntimeCleanupTarget | null> {
    if (!Number.isSafeInteger(observation.runtimeGeneration) || observation.runtimeGeneration <= 0) {
      return null
    }

    const target: RuntimeCleanupTarget = {
      boxId: observation.boxId,
      runnerId: runner.id,
      runnerEpoch: snapshot.runnerEpoch,
      runtimeGeneration: observation.runtimeGeneration,
    }
    const box = await manager.findOne(Box, {
      where: { id: observation.boxId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!box || box.runnerId !== runner.id || box.runtimeGeneration !== observation.runtimeGeneration) {
      return observation.actualState === BoxState.STARTED ? target : null
    }

    if (observation.actualState !== BoxState.STARTED) {
      const isPendingRuntime = !box.runtimeAuthorized && (await this.hasMatchingStartJob(manager, box))
      if (box.runtimeAuthorized || isPendingRuntime) {
        await this.saveLease(manager, {
          ...target,
          sequence: snapshot.sequence,
          actualState: observation.actualState,
          observedAt,
          leaseExpiresAt: observedAt,
        })
      }
      if (
        box.runtimeAuthorized &&
        box.desiredState === BoxDesiredState.STARTED &&
        AUTHORIZED_RUNNING_STATES.has(box.state)
      ) {
        committedChanges.push(
          await this.transitionRuntimeState(
            manager,
            box,
            {
              state: BoxState.ERROR,
              pending: false,
              recoverable: true,
              runtimeUnavailable: true,
              errorReason: `${RUNTIME_UNAVAILABLE_REASON}: runner observed ${observation.actualState}`,
            },
            observedAt,
            MeteringMode.DISK_ONLY,
          ),
        )
      }
      return null
    }

    const isAuthorizedRuntime =
      box.runtimeAuthorized &&
      box.desiredState === BoxDesiredState.STARTED &&
      (AUTHORIZED_RUNNING_STATES.has(box.state) || (box.state === BoxState.ERROR && box.runtimeUnavailable))
    const isPendingRuntime = !box.runtimeAuthorized && (await this.hasMatchingStartJob(manager, box))
    if (!isAuthorizedRuntime && !isPendingRuntime) {
      return target
    }

    const lease = await this.saveLease(manager, {
      ...target,
      sequence: snapshot.sequence,
      actualState: BoxState.STARTED,
      observedAt,
      leaseExpiresAt: this.expiresAt(observedAt),
    })

    if (isPendingRuntime) {
      return null
    }

    if (box.state === BoxState.ERROR) {
      committedChanges.push(
        await this.transitionRuntimeState(
          manager,
          box,
          {
            state: BoxState.STARTED,
            pending: false,
            recoverable: false,
            runtimeUnavailable: false,
            errorReason: null,
          },
          observedAt,
        ),
      )
      return null
    }

    const capUpdated = await this.usagePeriodWriter.updateComputeCap({
      manager,
      boxId: box.id,
      runnerEpoch: lease.runnerEpoch,
      runtimeGeneration: lease.runtimeGeneration,
      leaseExpiresAt: lease.leaseExpiresAt,
      observedAt,
    })
    if (!capUpdated) {
      await this.usagePeriodWriter.transition({
        manager,
        previousBox: box,
        currentBox: box,
        transitionAt: observedAt,
        modeOverride: MeteringMode.FULL,
      })
    }
    return null
  }

  private async evaluateStartedJob(manager: EntityManager, job: Job, now: Date): Promise<RuntimeStartEvaluation> {
    const runner = await manager.findOne(Runner, {
      where: { id: job.runnerId },
      lock: { mode: 'pessimistic_read' },
    })
    const box = await manager.findOne(Box, {
      where: { id: job.resourceId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!box || box.runnerId !== job.runnerId || box.lifecycleJobId !== job.id) {
      return { status: RuntimeStartFinalizationStatus.STALE, box: null }
    }

    const payload = job.getPayload<{ runtimeGeneration?: number }>()
    const result = job.getResultMetadata()
    const runtimeGeneration = payload?.runtimeGeneration
    const runnerEpoch = result?.runnerEpoch
    const resultGeneration = result?.runtimeGeneration
    const proofAt = job.completedAt
    const rejectionReasons = [
      job.status !== JobStatus.COMPLETED ? 'job is not completed' : null,
      !RUNTIME_START_JOB_TYPES.has(job.type) ? 'job type is not a runtime start' : null,
      !runner ? 'runner no longer exists' : null,
      !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration <= 0 ? 'runtime generation is invalid' : null,
      box.runtimeGeneration !== runtimeGeneration ? 'runtime generation no longer owns the Box' : null,
      !(proofAt instanceof Date) ? 'completion timestamp is missing' : null,
      proofAt instanceof Date && proofAt.getTime() > now.getTime()
        ? 'completion timestamp is ahead of the database clock'
        : null,
    ].filter((reason): reason is string => reason !== null)
    if (rejectionReasons.length > 0) {
      this.logger.warn(`Rejected runtime proof for Job ${job.id}: ${rejectionReasons.join(', ')}`)
      return { status: RuntimeStartFinalizationStatus.REJECTED, box }
    }

    const proofExpiresAt = this.expiresAt(proofAt)
    const existingLease = await manager.findOne(BoxRuntimeLease, {
      where: { boxId: box.id },
      lock: { mode: 'pessimistic_write' },
    })
    const currentHeartbeatProof =
      existingLease?.runnerId === job.runnerId &&
      existingLease.runnerEpoch === runner.runtimeEpoch &&
      existingLease.runtimeGeneration === runtimeGeneration &&
      existingLease.actualState === BoxState.STARTED &&
      existingLease.leaseExpiresAt.getTime() > now.getTime()

    if (currentHeartbeatProof) {
      return { status: RuntimeStartFinalizationStatus.CONFIRMED, box }
    }

    const sameRuntimeGeneration =
      existingLease?.runnerId === job.runnerId && existingLease.runtimeGeneration === runtimeGeneration
    const sameResultRuntime =
      typeof runnerEpoch === 'string' && sameRuntimeGeneration && existingLease?.runnerEpoch === runnerEpoch
    if (
      sameRuntimeGeneration &&
      existingLease &&
      existingLease.observedAt.getTime() >= proofAt.getTime() &&
      existingLease.actualState !== BoxState.STARTED
    ) {
      return { status: RuntimeStartFinalizationStatus.REJECTED, box }
    }
    if (proofExpiresAt.getTime() <= now.getTime()) {
      return { status: RuntimeStartFinalizationStatus.REJECTED, box }
    }
    if (typeof runnerEpoch !== 'string' || resultGeneration !== runtimeGeneration) {
      return { status: RuntimeStartFinalizationStatus.WAITING, box }
    }
    if (runner.runtimeEpoch !== runnerEpoch) {
      return { status: RuntimeStartFinalizationStatus.WAITING, box }
    }
    if (sameResultRuntime && existingLease && existingLease.observedAt.getTime() >= proofAt.getTime()) {
      return { status: RuntimeStartFinalizationStatus.WAITING, box }
    }

    if (sameResultRuntime && existingLease) {
      Object.assign(existingLease, {
        sequence: runner.runtimeSequence,
        actualState: BoxState.STARTED,
        observedAt: proofAt,
        leaseExpiresAt:
          proofExpiresAt.getTime() > existingLease.leaseExpiresAt.getTime()
            ? proofExpiresAt
            : existingLease.leaseExpiresAt,
      })
      await manager.save(BoxRuntimeLease, existingLease)
    } else {
      await this.saveLease(manager, {
        boxId: box.id,
        runnerId: job.runnerId,
        runnerEpoch,
        runtimeGeneration,
        sequence: runner.runtimeSequence,
        actualState: BoxState.STARTED,
        observedAt: proofAt,
        leaseExpiresAt: proofExpiresAt,
      })
    }
    return { status: RuntimeStartFinalizationStatus.CONFIRMED, box }
  }

  private async acceptRunnerEpoch(
    manager: EntityManager,
    runner: Runner,
    snapshot: RunnerRuntimeSnapshot,
    observedAt: Date,
  ): Promise<boolean> {
    if (
      !Number.isSafeInteger(snapshot.runnerIncarnation) ||
      snapshot.runnerIncarnation <= 0 ||
      !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence <= 0
    ) {
      return false
    }

    if (snapshot.runnerIncarnation < runner.runtimeIncarnation) {
      return false
    }

    const epoch = await manager.findOne(RunnerRuntimeEpoch, {
      where: { runnerId: runner.id, runnerEpoch: snapshot.runnerEpoch },
      lock: { mode: 'pessimistic_write' },
    })
    if (snapshot.runnerIncarnation === runner.runtimeIncarnation) {
      if (runner.runtimeEpoch !== snapshot.runnerEpoch) {
        return false
      }
      if (!epoch || epoch.retiredAt || epoch.runnerIncarnation !== snapshot.runnerIncarnation) {
        return false
      }
      if (snapshot.sequence <= runner.runtimeSequence || snapshot.sequence <= epoch.lastSequence) {
        return false
      }
      epoch.lastSequence = snapshot.sequence
      await manager.save(RunnerRuntimeEpoch, epoch)
    } else {
      if (epoch) {
        return false
      }
      if (runner.runtimeEpoch) {
        await manager.update(
          RunnerRuntimeEpoch,
          { runnerId: runner.id, runnerEpoch: runner.runtimeEpoch, retiredAt: IsNull() },
          { retiredAt: observedAt },
        )
      }
      await manager.insert(RunnerRuntimeEpoch, {
        runnerId: runner.id,
        runnerEpoch: snapshot.runnerEpoch,
        runnerIncarnation: snapshot.runnerIncarnation,
        lastSequence: snapshot.sequence,
        activatedAt: observedAt,
        retiredAt: null,
      })
    }

    runner.runtimeEpoch = snapshot.runnerEpoch
    runner.runtimeIncarnation = snapshot.runnerIncarnation
    runner.runtimeSequence = snapshot.sequence
    await manager.update(
      Runner,
      { id: runner.id },
      {
        runtimeEpoch: snapshot.runnerEpoch,
        runtimeIncarnation: snapshot.runnerIncarnation,
        runtimeSequence: snapshot.sequence,
      },
    )
    return true
  }

  private async hasMatchingStartJob(manager: EntityManager, box: Box): Promise<boolean> {
    if (!box.lifecycleJobId) {
      return false
    }
    const job = await manager.findOne(Job, { where: { id: box.lifecycleJobId } })
    if (
      !job ||
      !RUNTIME_START_JOB_TYPES.has(job.type) ||
      job.runnerId !== box.runnerId ||
      job.status === JobStatus.FAILED
    ) {
      return false
    }
    return job.getPayload<{ runtimeGeneration?: number }>()?.runtimeGeneration === box.runtimeGeneration
  }

  private async saveLease(manager: EntityManager, input: Omit<BoxRuntimeLease, 'updatedAt'>): Promise<BoxRuntimeLease> {
    const lease =
      (await manager.findOne(BoxRuntimeLease, {
        where: { boxId: input.boxId },
        lock: { mode: 'pessimistic_write' },
      })) ?? new BoxRuntimeLease()
    Object.assign(lease, input)
    return manager.save(BoxRuntimeLease, lease)
  }

  private async transitionRuntimeState(
    manager: EntityManager,
    box: Box,
    update: Partial<Box>,
    transitionAt: Date,
    modeOverride?: MeteringMode,
  ): Promise<CommittedBoxChange> {
    const previousBox = manager.create(Box, { ...box })
    Object.assign(box, update, { updatedAt: transitionAt })
    box.assertValid()
    const invariantChanges = box.enforceInvariants()
    await manager.update(Box, box.id, { ...update, ...invariantChanges, updatedAt: transitionAt })
    await this.usagePeriodWriter.transition({
      manager,
      previousBox,
      currentBox: box,
      transitionAt,
      modeOverride,
    })
    await manager.upsert(BoxLastActivity, { boxId: box.id, lastActivityAt: transitionAt }, ['boxId'])
    return { previousBox, currentBox: box }
  }

  private async reserveCleanup(manager: EntityManager, target: RuntimeCleanupTarget): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(BoxRuntimeCleanup)
      .values({ ...target, jobId: null })
      .orIgnore()
      .returning('id')
      .execute()
    if (Array.isArray(result.raw) && result.raw.length === 1) {
      return true
    }

    const cleanup = await manager.findOne(BoxRuntimeCleanup, {
      where: target,
      lock: { mode: 'pessimistic_write' },
    })
    if (!cleanup?.jobId) {
      return false
    }

    const job = await manager.findOne(Job, {
      where: { id: cleanup.jobId },
      lock: { mode: 'pessimistic_read' },
    })
    if (job && job.status !== JobStatus.COMPLETED && job.status !== JobStatus.FAILED) {
      return false
    }

    cleanup.jobId = null
    await manager.save(BoxRuntimeCleanup, cleanup)
    return true
  }

  private uniqueObservations(observations: RunnerBoxRuntimeObservation[]): RunnerBoxRuntimeObservation[] {
    const byBoxId = new Map<string, RunnerBoxRuntimeObservation>()
    for (const observation of observations) {
      if (byBoxId.has(observation.boxId)) {
        throw new Error(`Runner inventory contains duplicate Box ${observation.boxId}`)
      }
      byBoxId.set(observation.boxId, observation)
    }
    return [...byBoxId.values()].sort((left, right) => left.boxId.localeCompare(right.boxId))
  }

  private runtimeKey(boxId: string, runtimeGeneration: number): string {
    return `${boxId}:${runtimeGeneration}`
  }

  private snapshotOf(lease: BoxRuntimeLease): RuntimeLeaseSnapshot {
    return {
      boxId: lease.boxId,
      runnerEpoch: lease.runnerEpoch,
      runtimeGeneration: lease.runtimeGeneration,
      sequence: lease.sequence,
      leaseExpiresAt: lease.leaseExpiresAt,
    }
  }

  private matchesSnapshot(lease: BoxRuntimeLease, snapshot: RuntimeLeaseSnapshot): boolean {
    return (
      lease.boxId === snapshot.boxId &&
      lease.runnerEpoch === snapshot.runnerEpoch &&
      lease.runtimeGeneration === snapshot.runtimeGeneration &&
      lease.sequence === snapshot.sequence &&
      lease.leaseExpiresAt.getTime() === snapshot.leaseExpiresAt.getTime()
    )
  }

  private expiresAt(observedAt: Date): Date {
    const leaseSeconds = this.config.getOrThrow('runtime.leaseSeconds')
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
      throw new Error('runtime.leaseSeconds must be a positive integer')
    }
    return new Date(observedAt.getTime() + leaseSeconds * 1000)
  }

  private async databaseNow(manager: EntityManager): Promise<Date> {
    const [row] = await manager.query(`SELECT clock_timestamp() AS "now"`)
    return new Date(row.now)
  }
}
