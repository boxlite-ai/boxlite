import { NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'
import { Box } from '../entities/box.entity'
import { BoxConflictError } from '../errors/box-conflict.error'
import { OutboundControlRecord } from '../entities/outbound-control-record'
import { OutboundSnapshot, validOutboundRevision, validOutboundSnapshot } from '../runner-adapter/outbound-control'
import { validManagedControl } from '../runner-adapter/protected-outbound'
import { validBootstrapIntent } from '../runner-adapter/protected-runner'

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
    (control.bootstrap !== undefined && !validBootstrapIntent(control.bootstrap)) ||
    (control.managed !== undefined && !validManagedControl(control.managed)) ||
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
  const result: OutboundSnapshot = {
    revision: outboundRecord(box).revision,
    policy: { mode: box.outboundEnabled ? 'enabled' : 'disabled', allow_net: box.outboundAllowNet ?? [] },
  }
  if (!validOutboundSnapshot(result)) throw new ServiceUnavailableException('Stored outbound policy is invalid')
  return result
}

/** Call with the Box row locked on the primary so intent and references describe one owner. */
export async function hasProtectedBoxAuthority(manager: EntityManager, box: Box): Promise<boolean> {
  const { bootstrap, managed } = outboundRecord(box)
  if (bootstrap || managed) return true
  const [reference] = await manager.query(
    'SELECT 1 FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2 LIMIT 1',
    [box.organizationId, box.id],
  )
  return !!reference
}

/** Check ordinary ownership under the same Box row lock used by managed admission. */
export async function lockOrdinaryBox(
  manager: EntityManager,
  id: string,
  runnerId: string,
  allowPreviousRunner = false,
): Promise<void> {
  const box = await manager
    .createQueryBuilder(Box, 'box')
    .select(['box.id', 'box.organizationId', 'box.runnerId', 'box.prevRunnerId', 'box.outboundControl'])
    .where('box.id = :id', { id })
    .setLock('pessimistic_write')
    .getOne()
  if (!box || (box.runnerId !== runnerId && !(allowPreviousRunner && box.prevRunnerId === runnerId))) {
    throw new BoxConflictError()
  }
  if (await hasProtectedBoxAuthority(manager, box)) throw new BoxConflictError()
}

export type LockedOutboundBox = {
  box: Box
  manager: EntityManager
  write(control: OutboundControlRecord, confirmed?: OutboundSnapshot, dueAt?: Date | null): Promise<void>
}

/** All callbacks use a primary connection; a failed transaction is released before another operation starts. */
export class OutboundPolicyStore {
  constructor(private readonly dataSource: DataSource) {}

  async claimManagedWork(limit = 16): Promise<{ id: string; organizationId: string }[]> {
    if (limit <= 0) return []
    const runner = this.dataSource.createQueryRunner('master')
    try {
      return await runner.query(
        `
        WITH due AS (
          SELECT id FROM box WHERE "outboundControlDueAt" <= now()
            AND ("outboundControl" -> 'managed' ?| ARRAY['pending', 'unbindRelease']
              OR ("prevRunnerId" IS NOT NULL AND "outboundControl" -> 'managed' IS NOT NULL))
          ORDER BY "outboundControlDueAt", id LIMIT $1 FOR UPDATE SKIP LOCKED
        ), leased AS (
          UPDATE box b SET "outboundControlDueAt" = now() + interval '60 seconds'
          FROM due WHERE b.id = due.id RETURNING b.id, b."organizationId"
        ) SELECT * FROM leased
      `,
        [Math.min(limit, 16)],
      )
    } finally {
      await runner.release()
    }
  }

  async read(id: string, organizationId: string): Promise<Box> {
    const runner = this.dataSource.createQueryRunner('master')
    try {
      return await this.find(runner.manager, id, organizationId)
    } finally {
      await runner.release()
    }
  }

  async readForDiagnostic(id: string, organizationId: string): Promise<Box | undefined> {
    const runner = this.dataSource.createQueryRunner('master')
    try {
      await runner.startTransaction()
      await runner.query('LOCK TABLE box IN ROW SHARE MODE NOWAIT')
      const box = await this.find(runner.manager, id, organizationId, 'pessimistic_read')
      await runner.commitTransaction()
      return box
    } catch (error) {
      if (error instanceof NotFoundException || (error as { code?: string }).code === '55P03') return undefined
      throw error
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
  }

  async view<T>(
    id: string,
    organizationId: string,
    read: (box: Box, manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner('master')
    try {
      await runner.startTransaction('REPEATABLE READ')
      await runner.query('SET TRANSACTION READ ONLY')
      const result = await read(await this.find(runner.manager, id, organizationId), runner.manager)
      await runner.commitTransaction()
      return result
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
  }

  async locked<T>(
    id: string,
    organizationId: string,
    operation: (locked: LockedOutboundBox) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner('master')
    let committing = false
    try {
      await runner.connect()
      await runner.startTransaction()
      await runner.query("SET LOCAL lock_timeout = '5s'")
      const box = await this.find(runner.manager, id, organizationId, 'pessimistic_write')
      const result = await operation({
        box,
        manager: runner.manager,
        write: async (control, confirmed, dueAt) => {
          outboundRecord({ outboundControl: control } as Box)
          if (
            confirmed &&
            (!validOutboundSnapshot(confirmed) || control.revision !== confirmed.revision || control.pending)
          ) {
            throw new ServiceUnavailableException('Invalid confirmed outbound transaction')
          }
          const update = {
            outboundControl: control,
            ...(confirmed
              ? {
                  outboundEnabled: confirmed.policy.mode === 'enabled',
                  outboundAllowNet: confirmed.policy.allow_net.length ? confirmed.policy.allow_net : null,
                }
              : {}),
          }
          const result = await runner.manager.update(Box, { id, organizationId }, update)
          if (result.affected !== 1) throw new NotFoundException('Box not found')
          if (dueAt !== undefined) {
            await runner.query('UPDATE box SET "outboundControlDueAt" = $3 WHERE id = $1 AND "organizationId" = $2', [
              id,
              organizationId,
              dueAt,
            ])
          }
          Object.assign(box, update)
        },
      })
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

  private async find(
    manager: EntityManager,
    id: string,
    organizationId: string,
    lock?: 'pessimistic_read' | 'pessimistic_write',
  ): Promise<Box> {
    const query = manager
      .createQueryBuilder(Box, 'box')
      .addSelect('box.outboundControl')
      .where('box.id = :id AND box.organizationId = :organizationId', { id, organizationId })
    if (lock) query.setLock(lock)
    if (lock === 'pessimistic_read') query.setOnLocked('nowait')
    const box = await query.getOne()
    if (!box) throw new NotFoundException('Box not found')
    persistedOutbound(box)
    return box
  }
}
