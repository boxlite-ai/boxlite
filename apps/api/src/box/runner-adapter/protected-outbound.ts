import {
  OutboundSnapshot,
  sameOutboundSnapshot,
  validOutboundRevision,
  validOutboundSnapshot,
} from './outbound-control'
import type { ProtectedBootRoute } from './protected-runner'

export type ManagedBinding = { epoch: string; registration_id: string; registration_revision: string }
export type ManagedSnapshot = { snapshot: OutboundSnapshot; binding: ManagedBinding | null }
export type ManagedUpdate = { attempt_id: string; predecessor: ManagedSnapshot; candidate: ManagedSnapshot }
export type ProxyConnectionDiagnostic =
  | 'proxy_auth_failed'
  | 'proxy_unreachable'
  | 'proxy_timeout'
  | 'proxy_handshake_failed'

type ManagedMaterial = ProtectedBootRoute & { binding: ManagedBinding }

export type ManagedCommand =
  | { operation: 'inspect' }
  | { operation: 'prepare'; update: ManagedUpdate }
  | { operation: 'prepare_restore'; update: ManagedUpdate; failed: ManagedUpdate }
  | { operation: 'apply'; attempt_id: string; route: ManagedMaterial | null; predecessor_route: ManagedMaterial | null }
  | { operation: 'retire_prepared'; attempt_id: string; predecessor: ManagedSnapshot }
  | { operation: 'settle_unbind'; attempt_id: string; revision: string }

export type ManagedReceipt = {
  runner_id: string
  epoch: string
  durable: ManagedSnapshot
  installed: ManagedSnapshot | null
  proxy_diagnostic?: ProxyConnectionDiagnostic
  pending_attempt: string | null
  unbind_settlement: string | null
  rollback: { failed: ManagedUpdate; restored: ManagedSnapshot } | null
  retired_attempt: string | null
}

export type SealedEvidence = Pick<ManagedReceipt, 'durable' | 'installed' | 'rollback' | 'unbind_settlement'> & {
  pending: ManagedUpdate | null
  ordinary_pending: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const invalid = () => new Error('Runner did not return exact managed outbound evidence')

export function checkedManagedSnapshot(value: unknown, epoch: string): ManagedSnapshot {
  const input = record(value)
  if (!input || !validOutboundSnapshot(input.snapshot)) throw invalid()
  const { revision, policy } = input.snapshot
  const sanitized = { revision, policy: { mode: policy.mode, allow_net: [...policy.allow_net] } }
  if (input.binding === null) return { snapshot: sanitized, binding: null }
  const binding = record(input.binding)
  if (
    binding?.epoch !== epoch ||
    !validOutboundRevision(binding.registration_id) ||
    typeof binding.registration_revision !== 'string' ||
    !/^[1-9][0-9]{0,9}$/.test(binding.registration_revision) ||
    Number(binding.registration_revision) > 2147483647
  )
    throw invalid()
  return {
    snapshot: sanitized,
    binding: { epoch, registration_id: binding.registration_id, registration_revision: binding.registration_revision },
  }
}

export function validManagedControl(value: unknown): boolean {
  const control = record(value)
  if (!control || !validOutboundRevision(control.runnerId) || !validOutboundRevision(control.epoch)) return false
  if (control.claim !== undefined && (!control.pending || !validOutboundRevision(control.claim))) return false
  try {
    const epoch = control.epoch
    if (control.retirement !== undefined) {
      const retirement = record(control.retirement)
      if (
        !retirement ||
        typeof retirement.terminated !== 'boolean' ||
        (retirement.resolved !== undefined && (typeof retirement.resolved !== 'boolean' || !retirement.terminated))
      )
        return false
      checkedSealedEvidence(retirement.evidence, epoch)
    }
    if (control.binding !== null) {
      const binding = record(control.binding)
      if (
        binding?.epoch !== epoch ||
        !validOutboundRevision(binding.registration_id) ||
        typeof binding.registration_revision !== 'string' ||
        !/^[1-9][0-9]{0,9}$/.test(binding.registration_revision) ||
        Number(binding.registration_revision) > 2147483647
      )
        return false
    }
    if (control.pending !== undefined) {
      managedUpdate(control.pending, epoch)
    }
    if (control.restoration !== undefined) {
      const failed = managedUpdate(control.pending, epoch)
      const restore = managedUpdate(control.restoration, epoch)
      if (
        restore.attempt_id === failed.attempt_id ||
        !sameManagedSnapshot(restore.predecessor, failed.candidate) ||
        restore.candidate.snapshot.revision === failed.predecessor.snapshot.revision ||
        restore.candidate.snapshot.revision === failed.candidate.snapshot.revision ||
        !sameManagedSnapshot(
          {
            ...restore.candidate,
            snapshot: { ...restore.candidate.snapshot, revision: failed.predecessor.snapshot.revision },
          },
          failed.predecessor,
        )
      )
        return false
    }
    if (control.unbindRelease !== undefined) {
      const release = record(control.unbindRelease)
      if (
        !release ||
        control.pending ||
        control.binding !== null ||
        !validOutboundRevision(release.attemptId) ||
        !validOutboundRevision(release.revision)
      )
        return false
    }
    return true
  } catch {
    return false
  }
}

function token(value: unknown): string | null {
  if (value === null) return null
  if (validOutboundRevision(value)) return value
  throw invalid()
}

function managedUpdate(value: unknown, epoch: string): ManagedUpdate {
  const update = record(value)
  if (!update || !validOutboundRevision(update.attempt_id)) throw invalid()
  return {
    attempt_id: update.attempt_id,
    predecessor: checkedManagedSnapshot(update.predecessor, epoch),
    candidate: checkedManagedSnapshot(update.candidate, epoch),
  }
}

function rollbackEvidence(value: unknown, epoch: string): ManagedReceipt['rollback'] {
  if (value === null) return null
  const rollback = record(value)
  if (!rollback) throw invalid()
  return {
    failed: managedUpdate(rollback.failed, epoch),
    restored: checkedManagedSnapshot(rollback.restored, epoch),
  }
}

export function checkedSealedEvidence(value: unknown, epoch: string): SealedEvidence {
  const evidence = record(value)
  if (!evidence || typeof evidence.ordinary_pending !== 'boolean') throw invalid()
  return {
    durable: checkedManagedSnapshot(evidence.durable, epoch),
    installed: evidence.installed === null ? null : checkedManagedSnapshot(evidence.installed, epoch),
    pending: evidence.pending === null ? null : managedUpdate(evidence.pending, epoch),
    rollback: rollbackEvidence(evidence.rollback, epoch),
    unbind_settlement: token(evidence.unbind_settlement),
    ordinary_pending: evidence.ordinary_pending,
  }
}

export function checkedManagedReceipt(value: unknown, boxId: string, runnerId: string, epoch: string): ManagedReceipt {
  const wrapper = record(value)
  const receipt = record(wrapper?.receipt)
  if (wrapper?.box_id !== boxId || receipt?.runner_id !== runnerId || receipt.epoch !== epoch) throw invalid()
  const code = receipt.proxy_diagnostic
  const knownDiagnostic =
    code === 'proxy_auth_failed' ||
    code === 'proxy_unreachable' ||
    code === 'proxy_timeout' ||
    code === 'proxy_handshake_failed'
  return {
    runner_id: runnerId,
    epoch,
    durable: checkedManagedSnapshot(receipt.durable, epoch),
    installed: receipt.installed === null ? null : checkedManagedSnapshot(receipt.installed, epoch),
    ...(knownDiagnostic ? { proxy_diagnostic: code } : {}),
    pending_attempt: token(receipt.pending_attempt),
    unbind_settlement: token(receipt.unbind_settlement),
    rollback: rollbackEvidence(receipt.rollback, epoch),
    retired_attempt: token(receipt.retired_attempt),
  }
}

export function sameManagedSnapshot(left: ManagedSnapshot, right: ManagedSnapshot): boolean {
  return (
    sameOutboundSnapshot(left.snapshot, right.snapshot) &&
    (left.binding === null || right.binding === null
      ? left.binding === right.binding
      : left.binding.epoch === right.binding.epoch &&
        left.binding.registration_id === right.binding.registration_id &&
        left.binding.registration_revision === right.binding.registration_revision)
  )
}

export function authenticatedRollback(
  receipt: ManagedReceipt,
  runnerId: string,
  epoch: string,
  pending: ManagedUpdate,
): ManagedSnapshot | undefined {
  const proof = receipt.rollback
  if (
    receipt.runner_id !== runnerId ||
    receipt.epoch !== epoch ||
    receipt.pending_attempt !== null ||
    receipt.unbind_settlement !== null ||
    !proof ||
    !receipt.installed ||
    proof.failed.attempt_id !== pending.attempt_id ||
    !sameManagedSnapshot(proof.failed.predecessor, pending.predecessor) ||
    !sameManagedSnapshot(proof.failed.candidate, pending.candidate) ||
    proof.restored.snapshot.revision === 'initial' ||
    proof.restored.snapshot.revision === pending.predecessor.snapshot.revision ||
    proof.restored.snapshot.revision === pending.candidate.snapshot.revision ||
    !sameManagedSnapshot(proof.restored, receipt.durable) ||
    !sameManagedSnapshot(proof.restored, receipt.installed) ||
    !sameManagedSnapshot(
      { ...proof.restored, snapshot: { ...proof.restored.snapshot, revision: pending.predecessor.snapshot.revision } },
      pending.predecessor,
    )
  )
    return undefined
  return proof.restored
}
