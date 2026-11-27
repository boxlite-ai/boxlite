import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { DataSource, EntityManager, IsNull, Not } from 'typeorm'
import { Box } from '../entities/box.entity'
import { Runner } from '../entities/runner.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { CompleteOutboundControlRecord, OutboundControlRecord } from '../entities/outbound-control-record'
import {
  CompleteOutboundSnapshot,
  OutboundSnapshot,
  validCompleteOutboundSnapshot,
  validOutboundRevision,
  validOutboundSnapshot,
  validPreparedOutbound,
  validPreparedOutboundCreate,
} from '../runner-adapter/outbound-control'

/** COMMIT may have succeeded; callers must inspect a new primary transaction before recovery. */
export class OutboundCommitUnknown extends Error {
  constructor(cause: unknown) {
    super('Outbound transaction commit was not acknowledged', { cause })
  }
}

export function outboundRecord(box: Box): OutboundControlRecord {
  const control = box.outboundControl
  if (control == null) return { version: 1, revision: 'initial' }
  const pending = control.pending
  if (
    control.version !== 1 ||
    !validOutboundRevision(control.revision) ||
    (pending !== undefined &&
      (!pending ||
        !validOutboundRevision(pending.expected) ||
        !validOutboundSnapshot(pending.candidate) ||
        pending.expected === pending.candidate.revision ||
        pending.candidate.revision === 'initial' ||
        typeof pending.runnerId !== 'string' ||
        !pending.runnerId))
  ) {
    throw new ServiceUnavailableException('Stored outbound control metadata is invalid')
  }
  return control
}

export function persistedOutbound(box: Box): OutboundSnapshot {
  requireLegacyOutbound(box)
  const result: OutboundSnapshot = {
    revision: outboundRecord(box).revision,
    policy: { mode: box.outboundEnabled ? 'enabled' : 'disabled', allow_net: box.outboundAllowNet ?? [] },
  }
  if (!validOutboundSnapshot(result)) throw new ServiceUnavailableException('Stored outbound policy is invalid')
  return result
}

function requireLegacyOutbound(box: Box): void {
  if (box.completeOutboundControl != null) {
    throw new ConflictException({ code: 'complete_policy_required', message: 'Box requires complete outbound control' })
  }
}

/** Call with the Box row locked when making an archive admission decision. */
export function hasCompleteOutboundControl(manager: EntityManager, id: string): Promise<boolean> {
  return manager.existsBy(Box, { id, completeOutboundControl: Not(IsNull()) })
}

/** Take ownership locks before locking a Box or a job. */
export async function lockCompleteRunner(manager: EntityManager, runnerId?: string): Promise<void> {
  if (!runnerId) return
  await manager.query('SELECT id FROM "runner" WHERE id = $1 FOR SHARE', [runnerId])
  await manager.query('SELECT runner_id FROM complete_outbound_runner_enrollment WHERE runner_id = $1 FOR SHARE', [
    runnerId,
  ])
}

export async function verifiedCompleteRunner(
  manager: EntityManager,
  runnerId?: string,
  expectedLease?: string,
  allowExpired = false,
  forNewWork = false,
): Promise<{ runner: Runner; leaseId: string }> {
  if (!runnerId) throw new ServiceUnavailableException('No Runner owns the Box')
  await lockCompleteRunner(manager, runnerId)
  const [enrollment] = await manager.query(
    `SELECT e.lease_id FROM complete_outbound_runner_enrollment e
    JOIN "runner" r ON r.id = e.runner_id
    WHERE e.runner_id = $1
      AND r."apiVersion" IN ('0', '2')
      AND e.runner_key_sha256 = encode(sha256(convert_to(r."apiKey", 'UTF8')), 'hex')
      AND ($2::uuid IS NULL OR e.lease_id = $2) AND ($3 OR e.expires_at > clock_timestamp())
    FOR SHARE OF e`,
    [runnerId, expectedLease ?? null, allowExpired],
  )
  if (!enrollment) throw new ServiceUnavailableException('Runner has no verified complete outbound enrollment')
  const runner = await manager.findOneByOrFail(Runner, { id: runnerId })
  if (forNewWork && (runner.state !== RunnerState.READY || runner.unschedulable || runner.draining)) {
    throw new ServiceUnavailableException('Runner is unavailable for new complete outbound work')
  }
  return { runner, leaseId: enrollment.lease_id }
}

export function completeOutboundRecord(box: Box): CompleteOutboundControlRecord | null {
  const control = box.completeOutboundControl
  if (control == null) return null
  const pending = control.pending
  const finalization = control.finalization
  if (
    control.version !== 2 ||
    (control.committed === null ? pending?.kind !== 'create' : !validCompleteOutboundSnapshot(control.committed)) ||
    (pending !== undefined &&
      (!pending ||
        pending.kind !== (control.committed === null ? 'create' : 'replace') ||
        !validOutboundRevision(pending.attemptId) ||
        !pending.runnerId ||
        typeof pending.runnerId !== 'string' ||
        !Number.isSafeInteger(pending.generation) ||
        pending.generation <= 0 ||
        !validPreparedOutbound(pending.candidate) ||
        (pending.kind === 'create' &&
          ((pending.transport !== 'v0' && pending.transport !== 'v2') ||
            (pending.transport === 'v0' && !validOutboundRevision(pending.runnerLeaseId)) ||
            (pending.transport === 'v2' &&
              (!validOutboundRevision(pending.jobId) || !validOutboundRevision(pending.claimId))) ||
            !validOutboundRevision(pending.incarnation) ||
            !validPreparedOutboundCreate(pending.candidate))) ||
        (pending.kind === 'replace' &&
          (!validOutboundRevision(pending.incarnation) ||
            !validOutboundRevision(pending.runnerLeaseId) ||
            typeof pending.previousProtected !== 'boolean' ||
            (pending.restorationRevision !== undefined &&
              (!validOutboundRevision(pending.restorationRevision) ||
                pending.restorationRevision === 'initial' ||
                pending.restorationRevision === pending.candidate.snapshot.revision ||
                pending.restorationRevision === control.committed?.revision)))) ||
        pending.candidate.snapshot.revision === control.committed?.revision)) ||
    (finalization !== undefined &&
      (!finalization ||
        pending !== undefined ||
        !control.committed ||
        typeof finalization.retainProtection !== 'boolean' ||
        typeof finalization.runnerId !== 'string' ||
        !finalization.runnerId ||
        !validOutboundRevision(finalization.runnerLeaseId) ||
        !validOutboundRevision(finalization.attempt?.incarnation) ||
        !validOutboundRevision(finalization.attempt.attempt_id) ||
        !Number.isSafeInteger(finalization.attempt.generation) ||
        finalization.attempt.generation <= 0 ||
        !validCompleteOutboundSnapshot(finalization.attempt.previous) ||
        !validPreparedOutbound(finalization.attempt.candidate)))
  ) {
    throw new ServiceUnavailableException('Stored complete outbound control metadata is invalid')
  }
  return control
}

export function persistedCompleteOutbound(box: Box): CompleteOutboundSnapshot | null {
  const control = completeOutboundRecord(box)
  if (control) return control.committed
  const legacy = persistedOutbound(box)
  return { revision: legacy.revision, admission: 'legacy', policy: { ...legacy.policy, deny_net: [] } }
}

export function pendingCompleteOutboundRevision(box: Box): string | undefined {
  const control = completeOutboundRecord(box)
  return control ? control.pending?.candidate.snapshot.revision : outboundRecord(box).pending?.candidate.revision
}

export type LockedOutboundBox = {
  box: Box
  write(control: OutboundControlRecord, confirmed?: OutboundSnapshot): Promise<void>
}

export type LockedCompleteOutboundBox = {
  box: Box
  runner(expectedLease?: string, allowExpired?: boolean): ReturnType<typeof verifiedCompleteRunner>
  write(
    control: CompleteOutboundControlRecord | null,
    generation?: number,
    legacy?: CompleteOutboundSnapshot,
  ): Promise<void>
}

/** All callbacks use a primary connection; a failed transaction is released before another operation starts. */
export class OutboundPolicyStore {
  constructor(private readonly dataSource: DataSource) {}

  async read(id: string, organizationId: string): Promise<Box> {
    const runner = this.dataSource.createQueryRunner('master')
    try {
      return await this.find(runner.manager, id, organizationId, false)
    } finally {
      await runner.release()
    }
  }

  async locked<T>(
    id: string,
    organizationId: string,
    operation: (locked: LockedOutboundBox) => Promise<T>,
  ): Promise<T> {
    return this.transaction(id, organizationId, false, async (manager, box) => {
      requireLegacyOutbound(box)
      return operation({
        box,
        write: async (control, confirmed) => {
          outboundRecord({ outboundControl: control } as Box)
          if (
            confirmed &&
            (!validOutboundSnapshot(confirmed) || control.revision !== confirmed.revision || control.pending)
          ) {
            throw new ServiceUnavailableException('Invalid confirmed outbound transaction')
          }
          await this.update(manager, box, {
            outboundControl: control,
            ...(confirmed ? this.legacyPolicy(confirmed) : {}),
          })
        },
      })
    })
  }

  async lockedComplete<T>(
    id: string,
    organizationId: string,
    admit: boolean,
    operation: (locked: LockedCompleteOutboundBox) => Promise<T>,
  ): Promise<T> {
    return this.transaction(id, organizationId, true, (manager, box) =>
      operation({
        box,
        runner: (expectedLease, allowExpired = !admit) =>
          verifiedCompleteRunner(manager, box.runnerId, expectedLease, allowExpired, admit),
        write: async (control, generation, legacy) => {
          completeOutboundRecord({ completeOutboundControl: control } as Box)
          if (
            legacy &&
            (control ||
              legacy.admission !== 'legacy' ||
              legacy.policy.deny_net.length ||
              !validOutboundSnapshot({
                revision: legacy.revision,
                policy: { mode: legacy.policy.mode, allow_net: legacy.policy.allow_net },
              }))
          ) {
            throw new ServiceUnavailableException('Invalid legacy restoration')
          }
          await this.update(manager, box, {
            completeOutboundControl: control,
            ...(generation === undefined ? {} : { completeOutboundGeneration: generation }),
            ...(legacy
              ? { outboundControl: { version: 1, revision: legacy.revision }, ...this.legacyPolicy(legacy) }
              : {}),
          })
        },
      }),
    )
  }

  private async update(
    manager: EntityManager,
    box: Box,
    update: Pick<
      Partial<Box>,
      | 'outboundControl'
      | 'outboundEnabled'
      | 'outboundAllowNet'
      | 'completeOutboundControl'
      | 'completeOutboundGeneration'
    >,
  ) {
    const result = await manager.update(Box, { id: box.id, organizationId: box.organizationId }, update as never)
    if (result.affected !== 1) throw new NotFoundException('Box not found')
    Object.assign(box, update)
  }

  private legacyPolicy(snapshot: OutboundSnapshot) {
    return {
      outboundEnabled: snapshot.policy.mode === 'enabled',
      outboundAllowNet: snapshot.policy.allow_net.length ? snapshot.policy.allow_net : null,
    }
  }

  private async transaction<T>(
    id: string,
    organizationId: string,
    lockRunner: boolean,
    operation: (manager: EntityManager, box: Box) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner('master')
    let committing = false
    try {
      await runner.connect()
      await runner.startTransaction()
      await runner.query("SET LOCAL lock_timeout = '5s'")
      const owner = lockRunner
        ? await runner.manager.findOne(Box, { select: ['runnerId'], where: { id, organizationId } })
        : undefined
      if (owner) await lockCompleteRunner(runner.manager, owner.runnerId)
      const box = await this.find(runner.manager, id, organizationId, true)
      if (lockRunner && owner?.runnerId !== box.runnerId) {
        throw new ServiceUnavailableException('Box Runner changed before locking outbound control')
      }
      const result = await operation(runner.manager, box)
      committing = true
      await runner.commitTransaction()
      return result
    } catch (cause) {
      // ROLLBACK only releases this transaction; it cannot prove a preceding COMMIT failed.
      if (runner.isTransactionActive) await runner.rollbackTransaction().catch(() => undefined)
      if (committing) throw new OutboundCommitUnknown(cause)
      throw cause
    } finally {
      await runner.release()
    }
  }

  private async find(manager: EntityManager, id: string, organizationId: string, lock: boolean): Promise<Box> {
    const query = manager
      .createQueryBuilder(Box, 'box')
      .addSelect('box.outboundControl')
      .addSelect('box.completeOutboundControl')
      .addSelect('box.completeOutboundGeneration')
      .where('box.id = :id AND box.organizationId = :organizationId', { id, organizationId })
    if (lock) query.setLock('pessimistic_write')
    const box = await query.getOne()
    if (!box) throw new NotFoundException('Box not found')
    if (box.completeOutboundControl == null) persistedOutbound(box)
    else completeOutboundRecord(box)
    return box
  }
}
