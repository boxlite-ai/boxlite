import { ConflictException } from '@nestjs/common'
import {
  authenticatedRollback,
  ManagedBinding,
  ManagedCommand,
  ManagedReceipt,
  ManagedSnapshot,
  ManagedUpdate,
  sameManagedSnapshot,
} from '../runner-adapter/protected-outbound'
import { LockedOutboundBox, outboundRecord, persistedOutbound } from '../stores/outbound-policy.store'

export type ManagedRunnerControl = (command: ManagedCommand) => Promise<ManagedReceipt>
export type ConfirmedManagedUpdate = { update: ManagedUpdate; runnerId: string; epoch: string }

export function managedUnbindMarker(update: ManagedUpdate): string | null {
  return update.predecessor.binding && !update.candidate.binding ? update.attempt_id : null
}

export function confirmsManagedApply(receipt: ManagedReceipt, update: ManagedUpdate): boolean {
  return (
    receipt.pending_attempt === null &&
    receipt.installed !== null &&
    receipt.unbind_settlement === managedUnbindMarker(update) &&
    sameManagedSnapshot(receipt.durable, update.candidate) &&
    sameManagedSnapshot(receipt.installed, update.candidate)
  )
}

type Pin = {
  kind: 'pending' | 'committed' | 'retained'
  registration_id: string
  revision: number
  runner_id: string
  runtime_epoch: string | null
  attempt_id: string
}

function matchesPin(pin: Pin | undefined, binding: ManagedBinding | null, runner: string): boolean {
  if (!binding) return !pin
  return (
    !!pin &&
    pin.runner_id === runner &&
    pin.runtime_epoch === binding.epoch &&
    pin.registration_id === binding.registration_id &&
    String(pin.revision) === binding.registration_revision
  )
}

/** Reconcile only an exact observation from the enrolled Runner under the primary Box lock. */
export async function reconcileManagedOutbound(
  locked: LockedOutboundBox,
  control: ManagedRunnerControl,
  observed?: ManagedReceipt,
  confirmed?: (update: ConfirmedManagedUpdate) => void,
): Promise<boolean> {
  const { box } = locked
  const record = outboundRecord(box)
  const managed = record.managed
  if (!managed || managed.runnerId !== box.runnerId || box.prevRunnerId || record.pending || record.bootstrap)
    return false

  const current = { snapshot: persistedOutbound(box), binding: managed.binding }
  const receipt = observed ?? (await control({ operation: 'inspect' }).catch(() => undefined))
  if (
    !receipt ||
    receipt.runner_id !== managed.runnerId ||
    receipt.epoch !== managed.epoch ||
    receipt.pending_attempt !== null ||
    !receipt.installed ||
    !sameManagedSnapshot(receipt.durable, receipt.installed)
  )
    return false

  if (managed.unbindRelease) {
    const { attemptId, revision } = managed.unbindRelease
    if (revision !== current.snapshot.revision || !sameManagedSnapshot(receipt.durable, current)) return false
    if (receipt.unbind_settlement !== null) {
      if (receipt.unbind_settlement !== attemptId) return false
      const released = await control({ operation: 'settle_unbind', attempt_id: attemptId, revision }).catch(
        () => undefined,
      )
      if (
        !released ||
        released.runner_id !== managed.runnerId ||
        released.epoch !== managed.epoch ||
        released.pending_attempt !== null ||
        released.unbind_settlement !== null ||
        !released.installed ||
        !sameManagedSnapshot(released.durable, current) ||
        !sameManagedSnapshot(released.installed, current)
      )
        return false
    }
    await locked.write({ ...record, managed: { ...managed, unbindRelease: undefined } }, undefined, null)
    return true
  }

  const pending = managed.pending
  if (!pending || !sameManagedSnapshot(pending.predecessor, current)) return false
  if (managed.restoration) {
    const restore = managed.restoration
    if (!confirmsManagedApply(receipt, restore)) return false
    const marker = managedUnbindMarker(restore)
    const release = marker ? { attemptId: marker, revision: restore.candidate.snapshot.revision } : undefined
    await settlePinChange(locked, restore.candidate, false, release)
    return !release
  }
  const restored = authenticatedRollback(receipt, managed.runnerId, managed.epoch, pending)
  const marker = managedUnbindMarker(pending)
  const applied = confirmsManagedApply(receipt, pending)
  const retired =
    receipt.retired_attempt === pending.attempt_id &&
    receipt.unbind_settlement === null &&
    sameManagedSnapshot(receipt.durable, current)
  if (!applied && !restored && !retired) return false
  const next = applied ? pending.candidate : (restored ?? current)
  const unbindRelease = applied && marker ? { attemptId: marker, revision: next.snapshot.revision } : undefined
  if (applied) confirmed?.({ update: pending, runnerId: managed.runnerId, epoch: managed.epoch })
  await settlePinChange(locked, next, applied, unbindRelease)
  return !unbindRelease
}

/** A sealed, terminated epoch can no longer publish any of its pending stages. */
export async function settleTerminatedOutbound(locked: LockedOutboundBox): Promise<boolean> {
  const record = outboundRecord(locked.box)
  const managed = record.managed
  const retired = managed?.retirement
  if (!retired?.terminated || retired.evidence.ordinary_pending || record.pending) return false
  const { evidence } = retired
  const current = { snapshot: persistedOutbound(locked.box), binding: managed.binding }
  const pending = managed.pending
  if (!pending) {
    if (evidence.pending || !sameManagedSnapshot(evidence.durable, current)) return false
    if (managed.unbindRelease) {
      await locked.write({ ...record, managed: { ...managed, unbindRelease: undefined } }, undefined, null)
    }
    return true
  }
  if (!sameManagedSnapshot(pending.predecessor, current)) return false
  if (managed.restoration) {
    const restore = managed.restoration
    if (
      evidence.pending &&
      (evidence.pending.attempt_id !== restore.attempt_id ||
        !sameManagedSnapshot(evidence.pending.predecessor, restore.predecessor) ||
        !sameManagedSnapshot(evidence.pending.candidate, restore.candidate))
    )
      return false
    const restored = !evidence.pending && sameManagedSnapshot(evidence.durable, restore.candidate)
    if (!restored && !sameManagedSnapshot(evidence.durable, pending.candidate)) {
      const rolledBack = authenticatedRollback(
        {
          ...evidence,
          runner_id: managed.runnerId,
          epoch: managed.epoch,
          pending_attempt: evidence.pending?.attempt_id ?? null,
          retired_attempt: null,
        },
        managed.runnerId,
        managed.epoch,
        restore,
        true,
      )
      if (!rolledBack) return false
    }
    await settlePinChange(locked, restored ? restore.candidate : current, false)
    return true
  }
  if (
    evidence.pending &&
    (evidence.pending.attempt_id !== pending.attempt_id ||
      !sameManagedSnapshot(evidence.pending.predecessor, pending.predecessor) ||
      !sameManagedSnapshot(evidence.pending.candidate, pending.candidate))
  )
    return false

  if (!evidence.pending && sameManagedSnapshot(evidence.durable, pending.candidate)) {
    await settlePinChange(locked, pending.candidate, true)
    return true
  }
  if (sameManagedSnapshot(evidence.durable, current)) {
    await settlePinChange(locked, current, false)
    return true
  }
  const restored = authenticatedRollback(
    {
      ...evidence,
      runner_id: managed.runnerId,
      epoch: managed.epoch,
      pending_attempt: evidence.pending?.attempt_id ?? null,
      retired_attempt: null,
    },
    managed.runnerId,
    managed.epoch,
    pending,
    true,
  )
  if (!restored) return false
  await settlePinChange(locked, restored, false)
  return true
}

async function settlePinChange(
  locked: LockedOutboundBox,
  next: ManagedSnapshot,
  applied: boolean,
  unbindRelease?: { attemptId: string; revision: string },
) {
  const { box, manager } = locked
  const record = outboundRecord(box)
  const managed = record.managed
  const pending = managed?.pending
  if (!pending) throw new ConflictException('Managed outbound attempt is missing')
  const pins: Pin[] = await manager.query(
    `SELECT kind, registration_id, revision, runner_id, runtime_epoch, attempt_id
    FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2`,
    [box.organizationId, box.id],
  )
  const committed = pins.find((pin) => pin.kind === 'committed')
  const shadowKind = managed.restoration ? 'retained' : 'pending'
  const candidate = pins.find((pin) => pin.kind === shadowKind)
  const restorationPin = managed.restoration && pins.find((pin) => pin.kind === 'pending')
  if (
    (!managed.restoration && pins.some((pin) => pin.kind === 'retained')) ||
    !matchesPin(committed, managed.binding, managed.runnerId) ||
    !matchesPin(candidate, pending.candidate.binding, managed.runnerId) ||
    (candidate && candidate.attempt_id !== pending.attempt_id) ||
    (managed.restoration &&
      (!matchesPin(restorationPin, managed.restoration.candidate.binding, managed.runnerId) ||
        (restorationPin && restorationPin.attempt_id !== managed.restoration.attempt_id)))
  )
    throw new ConflictException('Managed outbound reference ownership differs')

  const registrationIds = [...new Set(pins.map((pin) => pin.registration_id))].sort()
  if (registrationIds.length) {
    const lockedRegistrations = await manager.query(
      `SELECT id FROM outbound_proxy_registration
      WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR SHARE`,
      [box.organizationId, registrationIds],
    )
    if (lockedRegistrations.length !== registrationIds.length) {
      throw new ConflictException('Managed outbound registration ownership differs')
    }
  }

  if (applied && committed) {
    await manager.query(
      "DELETE FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2 AND kind = 'committed'",
      [box.organizationId, box.id],
    )
  }
  if (candidate) {
    await manager.query(
      applied
        ? "UPDATE outbound_proxy_reference SET kind = 'committed' WHERE organization_id = $1 AND box_id = $2 AND kind = 'pending'"
        : 'DELETE FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2 AND kind = $3',
      applied ? [box.organizationId, box.id] : [box.organizationId, box.id, shadowKind],
    )
  }
  if (restorationPin) {
    await manager.query(
      "DELETE FROM outbound_proxy_reference WHERE organization_id = $1 AND box_id = $2 AND kind = 'pending'",
      [box.organizationId, box.id],
    )
  }
  await locked.write(
    {
      ...record,
      revision: next.snapshot.revision,
      managed: {
        ...managed,
        binding: next.binding,
        pending: undefined,
        restoration: undefined,
        claim: undefined,
        unbindRelease,
      },
    },
    next.snapshot,
    unbindRelease ? new Date() : null,
  )
}
