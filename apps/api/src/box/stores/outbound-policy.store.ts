import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'
import { Box } from '../entities/box.entity'
import { OutboundControlRecord, ProtectedBootstrapIntent } from '../entities/outbound-control-record'
import { BoxState } from '../enums/box-state.enum'
import { OutboundSnapshot, validOutboundRevision, validOutboundSnapshot } from '../runner-adapter/outbound-control'
import type { ProtectedBootReceipt } from '../runner-adapter/protected-runner'

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
  const result: OutboundSnapshot = {
    revision: outboundRecord(box).revision,
    policy: { mode: box.outboundEnabled ? 'enabled' : 'disabled', allow_net: box.outboundAllowNet ?? [] },
  }
  if (!validOutboundSnapshot(result)) throw new ServiceUnavailableException('Stored outbound policy is invalid')
  return result
}

export type LockedOutboundBox = {
  box: Box
  manager: EntityManager
  write(control: OutboundControlRecord, confirmed?: OutboundSnapshot): Promise<void>
  writeBootstrap(
    intent: ProtectedBootstrapIntent | undefined,
    state?: BoxState,
    retirement?: ProtectedBootReceipt,
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
    organizationId: string | undefined,
    operation: (locked: LockedOutboundBox) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner('master')
    let committing = false
    try {
      await runner.connect()
      await runner.startTransaction()
      await runner.query("SET LOCAL lock_timeout = '5s'")
      const box = await this.find(runner.manager, id, organizationId, true)
      const criteria = { id, organizationId: box.organizationId }
      const result = await operation({
        box,
        manager: runner.manager,
        write: async (control, confirmed) => {
          const current = outboundRecord(box)
          if (current.bootstrap) {
            throw new ConflictException('Ordinary outbound policy is fenced by protected bootstrap')
          }
          control = { ...current, revision: control.revision, pending: control.pending }
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
          const result = await runner.manager.update(Box, criteria, update)
          if (result.affected !== 1) throw new NotFoundException('Box not found')
          Object.assign(box, update)
        },
        writeBootstrap: async (bootstrap, state, retirement) => {
          const current = outboundRecord(box)
          if (current.pending) throw new ConflictException('Outbound policy is still pending')
          const update = {
            outboundControl: {
              ...current,
              bootstrap,
              bootstrapGeneration: bootstrap?.key.attempt_id ?? current.bootstrapGeneration,
              bootstrapRetirement: retirement ?? current.bootstrapRetirement,
            },
            ...(state === undefined
              ? {}
              : {
                  state,
                  pending: String(state) !== String(box.desiredState),
                  ...(state === BoxState.STARTED ? { errorReason: null } : {}),
                }),
          }
          const result = await runner.manager.update(Box, criteria, update)
          if (result.affected !== 1) throw new NotFoundException('Box not found')
          Object.assign(box, update)
          if (state !== undefined) box.updatedAt = new Date()
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
    organizationId: string | undefined,
    lock: boolean,
  ): Promise<Box> {
    const query = manager.createQueryBuilder(Box, 'box').addSelect('box.outboundControl').where('box.id = :id', { id })
    if (organizationId !== undefined) query.andWhere('box.organizationId = :organizationId', { organizationId })
    if (lock) query.setLock('pessimistic_write')
    const box = await query.getOne()
    if (!box) throw new NotFoundException('Box not found')
    persistedOutbound(box)
    return box
  }
}
