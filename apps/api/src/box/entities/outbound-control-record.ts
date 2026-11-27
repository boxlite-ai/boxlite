import type { OutboundSnapshot } from '../runner-adapter/outbound-control'
import type { ProtectedBootKey, ProtectedBootReceipt } from '../runner-adapter/protected-runner'

/** Private durable intent; the full candidate survives loss of its coordinator. */
export type OutboundPending = {
  expected: string
  candidate: OutboundSnapshot
  runnerId: string
}

export type ProtectedBootstrapIntent = {
  key: ProtectedBootKey
  prepareFingerprint: string
  startFingerprint: string
  phase: 'reserved' | 'claimed' | 'confirmed' | 'retiring'
  nativeId?: string
  startClaimed: boolean
  epoch?: string
}

export type OutboundControlRecord = {
  version: 1
  revision: string
  pending?: OutboundPending
  bootstrap?: ProtectedBootstrapIntent
  bootstrapGeneration?: string
  bootstrapRetirement?: ProtectedBootReceipt
}
