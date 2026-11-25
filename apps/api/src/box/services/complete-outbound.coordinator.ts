import { BadRequestException, ConflictException, HttpException, ServiceUnavailableException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Box } from '../entities/box.entity'
import { CompleteReplaceIntent, replaceAttempt } from '../entities/outbound-control-record'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import {
  CompleteOutboundPolicy,
  CompleteOutboundSnapshot,
  RunnerOutboundControl,
  sameCompleteOutboundSnapshot,
  validCompleteOutboundPolicy,
} from '../runner-adapter/outbound-control'
import {
  LockedCompleteOutboundBox,
  OutboundCommitUnknown,
  OutboundPolicyStore,
  completeOutboundRecord,
  outboundRecord,
  persistedCompleteOutbound,
} from '../stores/outbound-policy.store'
import type { OutboundPrecondition } from './outbound-policy.coordinator'

type Replacement = { owner: CompleteReplaceIntent; previous: CompleteOutboundSnapshot }

export class CompleteOutboundCoordinator {
  constructor(private readonly store: OutboundPolicyStore) {}

  async replace(id: string, organizationId: string, policy: CompleteOutboundPolicy, matches?: OutboundPrecondition) {
    if (!validCompleteOutboundPolicy(policy)) throw new BadRequestException('Invalid complete outbound policy')
    const { owner, previous } = await this.reserve(id, organizationId, policy, matches)
    const candidate = owner.candidate.snapshot
    try {
      await this.store.lockedComplete(id, organizationId, false, async (locked) => {
        const pending = this.pending(locked.box)
        if (!pending || pending.owner.attemptId !== owner.attemptId || pending.owner.restorationRevision) {
          throw new ConflictException('Complete outbound replacement is no longer current')
        }
        const attempt = replaceAttempt(owner, previous)
        const { runner } = await locked.runner(owner.runnerLeaseId, false)
        const receipt = await new RunnerOutboundControl(runner, locked.box.id).hostedOutbound({
          operation: 'apply',
          attempt,
        })
        if (receipt.outcome === 'cancelled') {
          throw new ConflictException('Runtime cancelled the complete outbound replacement')
        }
        if (receipt.outcome !== 'applied' || !sameCompleteOutboundSnapshot(receipt.snapshot, candidate)) {
          throw unresolved()
        }
        await locked.write({
          version: 2,
          committed: candidate,
          finalization: {
            attempt,
            runnerId: owner.runnerId,
            runnerLeaseId: owner.runnerLeaseId,
            retainProtection: true,
          },
        })
      })
    } catch (cause) {
      const current = await this.store.read(id, organizationId).catch(() => null)
      const committed = current && persistedCompleteOutbound(current)
      if (
        current?.completeOutboundGeneration !== owner.generation ||
        current.runnerId !== owner.runnerId ||
        current.completeOutboundControl?.pending ||
        !committed ||
        !sameCompleteOutboundSnapshot(committed, candidate)
      ) {
        await this.recover(id, organizationId, owner.attemptId).catch(() => undefined)
        if (cause instanceof OutboundCommitUnknown) throw unresolved()
        throw cause
      }
    }
    // A committed candidate is visible even if finalize must be retried later.
    await this.finalize(id, organizationId, owner.attemptId).catch(() => undefined)
    return candidate
  }

  async recover(id: string, organizationId: string, onlyAttempt?: string): Promise<void> {
    const recoverRestoration = await this.store.lockedComplete(id, organizationId, false, async (locked) => {
      const pending = this.pending(locked.box)
      if (!pending || (onlyAttempt && pending.owner.attemptId !== onlyAttempt)) return false
      const { owner, previous } = pending
      if (owner.restorationRevision) return true
      const attempt = replaceAttempt(owner, previous)
      const { runner } = await locked.runner(owner.runnerLeaseId)
      const control = new RunnerOutboundControl(runner, locked.box.id)
      let receipt = await control.hostedOutbound({ operation: 'cancel', attempt })
      if (receipt.outcome === 'pending') {
        receipt = await control.hostedOutbound({ operation: 'reconcile', attempt })
      }
      if (receipt.outcome === 'cancelled') {
        await locked.write(owner.previousProtected ? { version: 2, committed: previous } : null)
        return false
      }
      if (receipt.outcome !== 'applied' || !sameCompleteOutboundSnapshot(receipt.snapshot, owner.candidate.snapshot)) {
        throw unresolved()
      }
      await locked.write({
        version: 2,
        committed: previous,
        pending: { ...owner, restorationRevision: randomUUID() },
      })
      return true
    })
    if (recoverRestoration) {
      await this.store.lockedComplete(id, organizationId, false, (locked) => this.restore(locked, onlyAttempt))
    }
    await this.finalize(id, organizationId, onlyAttempt)
  }

  private async reserve(
    id: string,
    organizationId: string,
    policy: CompleteOutboundPolicy,
    matches?: OutboundPrecondition,
  ): Promise<Replacement> {
    let reserved: Replacement | undefined
    try {
      return await this.store.lockedComplete(id, organizationId, true, async ({ box, write, runner: verify }) => {
        const current = completeOutboundRecord(box)
        if (current?.pending || current?.finalization || (!current && outboundRecord(box).pending)) {
          throw new ConflictException({
            code: 'outbound_replace_busy',
            message: 'An outbound operation is still pending',
          })
        }
        if (
          box.state !== BoxState.STARTED ||
          box.desiredState !== BoxDesiredState.STARTED ||
          box.pending ||
          !box.runnerId
        ) {
          throw new ConflictException({
            code: 'outbound_not_running',
            message: 'Outbound policy updates require a running Box',
          })
        }
        const previous = persistedCompleteOutbound(box)
        if (!previous) throw unresolved()
        if (matches && !matches(previous.revision)) throw new HttpException('Outbound revision does not match', 412)

        const { runner, leaseId } = await verify()
        const receipt = await new RunnerOutboundControl(runner, box.id)
          .hostedOutbound({ operation: 'prepare', previous, revision: randomUUID(), policy })
          .catch((error: unknown) => {
            if (!(error instanceof HttpException)) throw error
            const detail = error.getResponse()
            throw new HttpException(
              { ...(typeof detail === 'string' ? { message: detail } : detail), effect: 'not_applied' },
              error.getStatus(),
              { cause: error },
            )
          })
        if (receipt.outcome !== 'prepared') throw unresolved()
        const owner: CompleteReplaceIntent = {
          kind: 'replace',
          incarnation: box.id,
          attemptId: randomUUID(),
          generation: (box.completeOutboundGeneration ?? 0) + 1,
          runnerId: box.runnerId,
          runnerLeaseId: leaseId,
          previousProtected: !!current,
          candidate: receipt.candidate,
        }
        reserved = { owner, previous }
        await write({ version: 2, committed: previous, pending: owner }, owner.generation)
        return reserved
      })
    } catch (cause) {
      if (!(cause instanceof OutboundCommitUnknown) || !reserved) throw cause
      const current = this.pending(await this.store.read(id, organizationId))
      if (current?.owner.attemptId !== reserved.owner.attemptId) throw unresolved()
      return current
    }
  }

  private pending(box: Box): Replacement | null {
    const record = completeOutboundRecord(box)
    const owner = record?.pending
    if (owner?.kind !== 'replace' || !record?.committed) return null
    if (
      owner.runnerId !== box.runnerId ||
      owner.incarnation !== box.id ||
      owner.generation !== box.completeOutboundGeneration
    ) {
      throw unresolved()
    }
    return { owner, previous: record.committed }
  }

  private async restore(locked: LockedCompleteOutboundBox, onlyAttempt?: string): Promise<void> {
    const pending = this.pending(locked.box)
    if (!pending || !pending.owner.restorationRevision || (onlyAttempt && pending.owner.attemptId !== onlyAttempt))
      return
    const { owner, previous } = pending
    const attempt = replaceAttempt(owner, previous)
    const revision = owner.restorationRevision!
    const restored = { ...previous, revision }
    const { runner } = await locked.runner(owner.runnerLeaseId)
    const receipt = await new RunnerOutboundControl(runner, locked.box.id).hostedOutbound({
      operation: 'restore',
      attempt,
      revision,
    })
    if (receipt.outcome !== 'restored' || !sameCompleteOutboundSnapshot(receipt.snapshot, restored)) throw unresolved()
    await locked.write({
      version: 2,
      committed: restored,
      finalization: {
        attempt,
        runnerId: owner.runnerId,
        runnerLeaseId: owner.runnerLeaseId,
        retainProtection: owner.previousProtected,
      },
    })
  }

  private async finalize(id: string, organizationId: string, onlyAttempt?: string): Promise<void> {
    await this.store.lockedComplete(id, organizationId, false, async ({ box, write, runner: verify }) => {
      const record = completeOutboundRecord(box)
      const pending = record?.finalization
      if (!pending || !record?.committed || (onlyAttempt && pending.attempt.attempt_id !== onlyAttempt)) return
      const target = record.committed
      if (
        pending.runnerId !== box.runnerId ||
        pending.attempt.incarnation !== box.id ||
        pending.attempt.generation !== box.completeOutboundGeneration
      )
        throw unresolved()
      const { runner } = await verify(pending.runnerLeaseId)
      const receipt = await new RunnerOutboundControl(runner, box.id).hostedOutbound({
        operation: 'finalize',
        attempt: pending.attempt,
      })
      if (receipt.outcome !== 'finalized' || !sameCompleteOutboundSnapshot(receipt.snapshot, target)) throw unresolved()
      if (pending.retainProtection) await write({ version: 2, committed: target })
      else await write(null, undefined, target)
    })
  }
}

function unresolved() {
  return new ServiceUnavailableException({
    code: 'outbound_pending',
    message: 'Complete outbound replacement is awaiting exact Runner evidence',
  })
}
