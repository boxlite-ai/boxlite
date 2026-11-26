import type { OutboundSnapshot } from '../runner-adapter/outbound-control'
import type { ManagedBinding, ManagedUpdate, SealedEvidence } from '../runner-adapter/protected-outbound'
import type { ProtectedBootKey } from '../runner-adapter/protected-runner'

export type ManagedBoot = {
  key: ProtectedBootKey
  generation: string
}

export type BootstrapIntent = ManagedBoot & {
  proxyName: string | null
  placeholderAllocation?: {
    deadline: number
    dispatchOwner?: string
    allocated?: true
    handoffDeadline?: number
    unconfirmed?: true
  }
  claim?: string
  epoch?: string
  retiredEpoch?: string | null
  restart?: boolean
  recovery?: { runnerId: string; epoch: string; binding: ManagedBinding | null }
}

/** Private durable intent; the full candidate survives loss of its coordinator. */
export type OutboundPending = {
  expected: string
  candidate: OutboundSnapshot
  runnerId: string
}

export type OutboundControlRecord = {
  version: 1
  revision: string
  pending?: OutboundPending
  bootstrap?: BootstrapIntent
  placeholderClosed?: { runnerId: string; attemptId: string }
  managed?: {
    runnerId: string
    epoch: string
    binding: ManagedBinding | null
    launch?: ManagedBoot
    pending?: ManagedUpdate
    restoration?: ManagedUpdate
    claim?: string
    rolloutRetry?: string
    retirement?: { evidence: SealedEvidence; terminated: boolean; resolved?: boolean }
    unbindRelease?: { attemptId: string; revision: string }
  }
}
