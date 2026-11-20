import { BadRequestException, ConflictException, HttpException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Box } from '../entities/box.entity'
import { OutboundPending } from '../entities/outbound-control-record'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { OutboundPolicy } from '../runner-adapter/network-policy'
import {
  OutboundControl,
  OutboundSnapshot,
  OutboundStatus,
  sameOutboundSnapshot,
  validOutboundSnapshot,
} from '../runner-adapter/outbound-control'
import {
  LockedOutboundBox,
  OutboundCommitUnknown,
  OutboundPolicyStore,
  outboundRecord,
  persistedOutbound,
} from '../stores/outbound-policy.store'
import { reconcileManagedOutbound } from './managed-outbound-reconciliation'

type Attempt = { pending: OutboundPending; previous: OutboundSnapshot; confirmed: boolean }
type Reservation = { attempt: Attempt } | { completed: Box } | { preconditionFailed: true } | { managedConflict: true }
export type OutboundPrecondition = (revision: string) => boolean

function samePending(left: OutboundPending | undefined, right: OutboundPending): boolean {
  return (
    !!left &&
    left.expected === right.expected &&
    left.runnerId === right.runnerId &&
    sameOutboundSnapshot(left.candidate, right.candidate)
  )
}

function completed(status: OutboundStatus, candidate: OutboundSnapshot): boolean {
  return (
    status.application_state === 'confirmed' &&
    status.pending_revision === undefined &&
    !!status.observed &&
    status.observed.application_state === 'confirmed' &&
    sameOutboundSnapshot(status.persisted, candidate) &&
    sameOutboundSnapshot(status.observed, candidate)
  )
}

function requireRunning(box: Box): void {
  if (box.state !== BoxState.STARTED || box.desiredState !== BoxDesiredState.STARTED || box.pending || !box.runnerId) {
    throw new ConflictException('Outbound policy updates require a running box')
  }
}

/**
 * Tx1 reserves full intent; Tx2 verifies that owner, applies under the row lock, and commits policy plus revision.
 * Recovery always reacquires a primary row lock after releasing the failed transaction.
 */
export class OutboundPolicyCoordinator {
  constructor(
    private readonly store: OutboundPolicyStore,
    private readonly control: (box: Box) => Promise<OutboundControl>,
  ) {}

  async status(
    id: string,
    organizationId: string,
  ): Promise<OutboundStatus & { runtime_persisted: OutboundSnapshot; capabilities: string[] }> {
    const box = await this.store.read(id, organizationId)
    const persisted = persistedOutbound(box)
    const runtime = await (await this.control(box)).status()
    const pending = outboundRecord(box).pending
    const confirmed = !pending && completed(runtime, persisted)
    return {
      persisted,
      runtime_persisted: runtime.persisted,
      observed: runtime.observed,
      application_state: confirmed
        ? 'confirmed'
        : pending || runtime.application_state === 'pending'
          ? 'pending'
          : 'uncertain',
      ...(pending
        ? { pending_revision: pending.candidate.revision }
        : runtime.pending_revision
          ? { pending_revision: runtime.pending_revision }
          : {}),
      capabilities: ['revision-v1'],
    }
  }

  async replace(
    id: string,
    organizationId: string,
    policy: OutboundPolicy,
    matches?: OutboundPrecondition,
  ): Promise<Box> {
    const candidate: OutboundSnapshot = { revision: randomUUID(), policy: structuredClone(policy) }
    if (!validOutboundSnapshot(candidate)) throw new BadRequestException('Invalid outbound policy')
    const reservation = await this.reserve(id, organizationId, async (locked) => {
      requireRunning(locked.box)
      let previous = persistedOutbound(locked.box)
      const control = await this.control(locked.box)
      let current = outboundRecord(locked.box)
      if (current.bootstrap || current.managed?.retirement) return { managedConflict: true }
      if (current.managed) {
        const { epoch, pending, unbindRelease } = current.managed
        const managed = control.managed
        if (
          (pending || unbindRelease) &&
          (!managed || !(await reconcileManagedOutbound(locked, (command) => managed(epoch, command))))
        )
          return { managedConflict: true }
        current = outboundRecord(locked.box)
        previous = persistedOutbound(locked.box)
        if (current.managed?.binding || current.managed?.runnerId !== locked.box.runnerId || locked.box.prevRunnerId)
          return { managedConflict: true }
      }
      const pending = current.pending
      let expected = previous.revision
      if (pending) {
        if (pending.runnerId !== locked.box.runnerId) throw new ConflictException('Outbound pending owner changed')
        const runtime = await control.status()
        if (completed(runtime, pending.candidate)) {
          current = { ...current, revision: pending.candidate.revision, pending: undefined }
          await locked.write(current, pending.candidate)
          previous = pending.candidate
          expected = previous.revision
        } else {
          if (matches || !runtime.observed)
            throw new ConflictException('Outbound application is unresolved; retry a complete update')
          // The next CAS fences a delayed request; observing its old expected revision alone never clears pending.
          expected = runtime.observed.revision
        }
      }
      if (matches && !matches(previous.revision)) return { preconditionFailed: true }
      const next: OutboundPending = { expected, candidate, runnerId: locked.box.runnerId }
      await locked.write({ ...current, revision: previous.revision, pending: next })
      return { attempt: { pending: next, previous, confirmed: false } }
    })
    if ('preconditionFailed' in reservation) throw new HttpException('Outbound precondition failed', 412)
    if ('managedConflict' in reservation) throw new ConflictException('A complete authorized proxy update is required')
    if ('completed' in reservation) return reservation.completed
    const attempt = reservation.attempt
    try {
      return await this.apply(id, organizationId, attempt)
    } catch (cause) {
      if (!attempt.confirmed) throw cause
      // A missing COMMIT reply is not evidence that the candidate failed to persist.
      const recovery = await this.reserve(id, organizationId, async (locked) => {
        const persisted = persistedOutbound(locked.box)
        const current = outboundRecord(locked.box)
        if (!current.pending && sameOutboundSnapshot(persisted, candidate)) return { completed: locked.box }
        if (!samePending(current.pending, attempt.pending) || !sameOutboundSnapshot(persisted, attempt.previous)) {
          throw new ConflictException('Outbound recovery lost ownership; application is uncertain')
        }
        requireRunning(locked.box)
        if (locked.box.runnerId !== attempt.pending.runnerId)
          throw new ConflictException('Outbound recovery runner changed')
        const restoration: OutboundPending = {
          expected: candidate.revision,
          candidate: { revision: randomUUID(), policy: attempt.previous.policy },
          runnerId: locked.box.runnerId,
        }
        await locked.write({ ...current, pending: restoration })
        return { attempt: { pending: restoration, previous: persisted, confirmed: false } }
      })
      if ('completed' in recovery) return recovery.completed
      if ('attempt' in recovery) await this.apply(id, organizationId, recovery.attempt)
      throw cause
    }
  }

  private async reserve(
    id: string,
    organizationId: string,
    prepare: (locked: LockedOutboundBox) => Promise<Reservation>,
  ): Promise<Reservation> {
    let prepared: Reservation | undefined
    try {
      return await this.store.locked(id, organizationId, async (locked) => {
        prepared = await prepare(locked)
        return prepared
      })
    } catch (cause) {
      if (!(cause instanceof OutboundCommitUnknown) || !prepared || !('attempt' in prepared)) throw cause
      const pending = prepared.attempt.pending
      const reservation = prepared
      // This second transaction sends nothing; absent or superseded intent cannot authorize dispatch.
      return this.store.locked(id, organizationId, async ({ box }) => {
        if (!samePending(outboundRecord(box).pending, pending) || box.runnerId !== pending.runnerId) {
          throw new ConflictException('Outbound reservation was not confirmed; retry the complete update')
        }
        return reservation
      })
    }
  }

  private async apply(id: string, organizationId: string, attempt: Attempt): Promise<Box> {
    return this.store.locked(id, organizationId, async (locked) => {
      const current = outboundRecord(locked.box)
      const pending = attempt.pending
      if (!current.pending && sameOutboundSnapshot(persistedOutbound(locked.box), pending.candidate)) return locked.box
      requireRunning(locked.box)
      if (!samePending(current.pending, pending) || locked.box.runnerId !== pending.runnerId) {
        throw new ConflictException('Outbound reservation lost ownership before dispatch')
      }
      const control = await this.control(locked.box)
      try {
        const result = await control.replace(pending.expected, pending.candidate)
        if (result !== 'applied')
          throw new ConflictException('Runner outbound precondition failed; application is uncertain')
      } catch (cause) {
        const status = await control.status().catch(() => null)
        if (!status || !completed(status, pending.candidate)) throw cause
      }
      attempt.confirmed = true
      await locked.write({ ...current, revision: pending.candidate.revision, pending: undefined }, pending.candidate)
      return locked.box
    })
  }
}
