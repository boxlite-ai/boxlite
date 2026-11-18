import type { OutboundSnapshot } from '../runner-adapter/outbound-control'

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
}
