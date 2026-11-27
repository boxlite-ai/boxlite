import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { timingSafeEqual } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { DataSource, EntityManager } from 'typeorm'
import { validate as isUuid } from 'uuid'
import { Box } from '../entities/box.entity'
import { ProtectedBootstrapIntent } from '../entities/outbound-control-record'
import { Runner } from '../entities/runner.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { BoxRepository } from '../repositories/box.repository'
import { checkedBootReceipt, ProtectedBootKey } from '../runner-adapter/protected-runner'
import {
  LockedOutboundBox,
  outboundRecord,
  OutboundCommitUnknown,
  OutboundPolicyStore,
  persistedOutbound,
} from '../stores/outbound-policy.store'

type Authorization = {
  operation: 'prepare' | 'start' | 'receipt' | 'retire'
  box_id: string
  key: ProtectedBootKey
  fingerprint?: string
  native_id?: string
}

function exactIntent({ box }: LockedOutboundBox, key: ProtectedBootKey): ProtectedBootstrapIntent {
  const intent = outboundRecord(box).bootstrap
  if (!intent || !isDeepStrictEqual(intent.key, key)) throw new ForbiddenException('Protected bootstrap owner differs')
  return intent
}

function matchesFingerprint(expected: string, value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{64}$/.test(value) &&
    /^[0-9a-f]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value, 'hex'))
  )
}

@Injectable()
export class ProtectedBootstrapService {
  private readonly store: OutboundPolicyStore

  constructor(
    private readonly source: DataSource,
    private readonly boxes: BoxRepository,
  ) {
    this.store = new OutboundPolicyStore(source)
  }

  async identity(runnerId: string, authorization: string | undefined): Promise<{ runner_id: string }> {
    const connection = this.source.createQueryRunner('master')
    try {
      await this.requireUniqueRunner(connection.manager, runnerId, authorization)
      return { runner_id: runnerId }
    } finally {
      await connection.release()
    }
  }

  async authorize(runnerId: string, authorization: string | undefined, request: Authorization) {
    return this.store.locked(request.box_id, undefined, async (locked) => {
      await this.requireUniqueRunner(locked.manager, runnerId, authorization)
      const intent = exactIntent(locked, request.key)
      if (intent.key.runner_id !== runnerId) throw new ForbiddenException('Protected bootstrap owner differs')

      switch (request.operation) {
        case 'prepare':
          this.requireCurrentReservation(locked, intent)
          if (!matchesFingerprint(intent.prepareFingerprint, request.fingerprint)) {
            throw new ForbiddenException('Protected preparation does not match its reservation')
          }
          break
        case 'start':
          this.requireCurrentReservation(locked, intent)
          if (
            !intent.nativeId ||
            intent.nativeId !== request.native_id ||
            !matchesFingerprint(intent.startFingerprint, request.fingerprint)
          ) {
            throw new ForbiddenException('Protected start does not match its reservation')
          }
          await locked.writeBootstrap({ ...intent, phase: 'claimed', startClaimed: true })
          break
        case 'receipt':
          break
        case 'retire':
          if (intent.phase !== 'retiring') throw new ForbiddenException('Protected bootstrap is not retiring')
          break
        default:
          throw new ForbiddenException('Unknown protected bootstrap operation')
      }
      return {
        runner_id: runnerId,
        native_id: intent.nativeId,
        start_claimed: intent.startClaimed,
        epoch: intent.epoch,
      }
    })
  }

  async reserve(box: Box, key: ProtectedBootKey, prepareFingerprint: string, startFingerprint: string): Promise<void> {
    await this.store.locked(box.id, box.organizationId, async (locked) => {
      const record = outboundRecord(locked.box)
      const current = record.bootstrap
      if (
        current?.phase === 'reserved' &&
        current.nativeId === undefined &&
        isDeepStrictEqual(current.key, key) &&
        matchesFingerprint(current.prepareFingerprint, prepareFingerprint) &&
        matchesFingerprint(current.startFingerprint, startFingerprint)
      ) {
        return
      }
      const intent = { key, prepareFingerprint, startFingerprint, phase: 'reserved' as const, startClaimed: false }
      this.requireCurrentReservation(locked, intent)
      if (
        record.bootstrap ||
        record.bootstrapGeneration === key.attempt_id ||
        !isUuid(key.attempt_id) ||
        ![BoxState.CREATING, BoxState.STARTING, BoxState.STOPPED].includes(locked.box.state) ||
        !isDeepStrictEqual(persistedOutbound(locked.box), key.policy)
      ) {
        throw new ConflictException('A protected bootstrap already owns this Box or attempt')
      }
      await locked.writeBootstrap(intent)
    })
  }

  async prepared(boxId: string, key: ProtectedBootKey, nativeId: string): Promise<void> {
    await this.store.locked(boxId, undefined, async (locked) => {
      const intent = exactIntent(locked, key)
      this.requireCurrentReservation(locked, intent)
      if (intent.nativeId && intent.nativeId !== nativeId) throw new ConflictException('Prepared native Box differs')
      await locked.writeBootstrap({ ...intent, nativeId })
    })
  }

  async beginRetirement(
    boxId: string,
    key: ProtectedBootKey,
    expectedEpoch?: string,
    onlyUnsettled = false,
  ): Promise<string | undefined> {
    return this.store.locked(boxId, undefined, async (locked) => {
      const intent = exactIntent(locked, key)
      if (onlyUnsettled && intent.phase === 'confirmed') {
        throw new ConflictException('Protected startup already settled')
      }
      if (expectedEpoch !== undefined && intent.epoch !== expectedEpoch) {
        throw new ConflictException('Runner did not return exact protected bootstrap evidence')
      }
      if (intent.phase !== 'retiring') await locked.writeBootstrap({ ...intent, phase: 'retiring' })
      return intent.epoch
    })
  }

  async settle(boxId: string, key: ProtectedBootKey, evidence: unknown): Promise<void> {
    let transition: Parameters<BoxRepository['publishCommittedUpdate']> | undefined
    try {
      await this.store.locked(boxId, undefined, async (locked) => {
        const intent = exactIntent(locked, key)
        const receipt = checkedBootReceipt(evidence, boxId, key, intent.epoch)
        const commit = async (...updates: Parameters<LockedOutboundBox['writeBootstrap']>) => {
          const previous = { ...locked.box }
          await locked.writeBootstrap(...updates)
          if (locked.box.state !== previous.state) {
            await this.boxes.upsertLastActivity(locked.manager, boxId, locked.box.updatedAt)
            transition = [locked.box, previous]
          }
        }
        if (receipt.outcome === 'confirmed' && receipt.epoch && intent.phase === 'claimed') {
          if (
            receipt.nativeId !== intent.nativeId ||
            locked.box.runnerId !== key.runner_id ||
            locked.box.desiredState !== BoxDesiredState.STARTED
          ) {
            throw new ConflictException('Protected startup no longer owns the assignment')
          }
          await commit({ ...intent, phase: 'confirmed', epoch: receipt.epoch }, BoxState.STARTED)
          return
        }
        if (receipt.outcome === 'retired' && intent.phase === 'retiring' && receipt.allocationClosed === true) {
          if (
            (intent.nativeId !== undefined && receipt.nativeId !== intent.nativeId) ||
            (receipt.epoch === null && intent.startClaimed && !receipt.noSpawn)
          ) {
            throw new ConflictException('Protected cleanup does not prove the exact native allocation')
          }
          await commit(undefined, BoxState.STOPPED, receipt)
          return
        }
        if (receipt.outcome === 'confirmed' && intent.phase === 'confirmed' && receipt.nativeId === intent.nativeId)
          return
        throw new ConflictException('Protected bootstrap evidence does not match its phase')
      })
    } catch (error) {
      if (!(error instanceof OutboundCommitUnknown) || !transition) throw error
      const [candidate] = transition
      const persisted = await this.store.read(boxId, candidate.organizationId)
      if (
        persisted.state !== candidate.state ||
        !isDeepStrictEqual(outboundRecord(persisted), outboundRecord(candidate))
      ) {
        throw error
      }
    }
    if (transition) {
      const [box, previous] = transition
      delete box.outboundControl
      await this.boxes.publishCommittedUpdate(box, previous)
    }
  }

  private requireCurrentReservation(locked: LockedOutboundBox, intent: ProtectedBootstrapIntent): void {
    if (
      intent.phase !== 'reserved' ||
      locked.box.runnerId !== intent.key.runner_id ||
      locked.box.desiredState !== BoxDesiredState.STARTED ||
      outboundRecord(locked.box).pending
    ) {
      throw new ForbiddenException('Protected bootstrap reservation is unavailable')
    }
  }

  private async requireUniqueRunner(manager: EntityManager, runnerId: string, authorization: string | undefined) {
    const token = authorization?.match(/^Bearer (\S+)$/i)?.[1]
    if (!token) throw new ForbiddenException('Runner identity is unavailable')
    const candidates = await manager.find(Runner, { where: { apiKey: token }, select: ['id', 'apiVersion'], take: 2 })
    if (candidates.length !== 1 || candidates[0].id !== runnerId || candidates[0].apiVersion !== '0') {
      throw new ForbiddenException('Runner identity is unavailable or ambiguous')
    }
  }
}
