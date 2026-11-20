import type {
  CompleteOutboundSnapshot,
  CompleteCreateAttempt,
  HostedOutboundAttempt,
  OutboundSnapshot,
  PreparedOutboundCreate,
} from '../runner-adapter/outbound-control'

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

type CompleteOutboundOwner = {
  attemptId: string
  runnerId: string
  generation: number
  candidate: PreparedOutboundCreate
}

type CompleteCreateOwner = CompleteOutboundOwner & {
  kind: 'create'
  incarnation: string
}

export type CompleteCreateIntent = CompleteCreateOwner &
  ({ transport: 'v0'; runnerLeaseId?: string } | { transport: 'v2'; jobId: string; claimId: string })
export type CompleteReplaceIntent = CompleteOutboundOwner & {
  kind: 'replace'
  incarnation: string
  previousProtected: boolean
  runnerLeaseId: string
  restorationRevision?: string
}

export type CompleteOutboundIntent = CompleteCreateIntent | CompleteReplaceIntent

export function replaceAttempt(
  owner: CompleteReplaceIntent,
  previous: CompleteOutboundSnapshot,
): HostedOutboundAttempt {
  return {
    incarnation: owner.incarnation,
    attempt_id: owner.attemptId,
    generation: owner.generation,
    previous,
    candidate: owner.candidate,
  }
}

export function createAttempt(owner: CompleteCreateIntent): CompleteCreateAttempt {
  return {
    incarnation: owner.incarnation,
    attempt_id: owner.attemptId,
    generation: owner.generation,
    prepared: owner.candidate,
    ...(owner.transport === 'v2' ? { job_id: owner.jobId, claim_id: owner.claimId } : {}),
  }
}

export const COMPLETE_CREATE_UNSUPPORTED_REASON = 'outbound_create_unsupported'

/** Private complete policy, with no committed snapshot until the first create settles. */
export type CompleteOutboundControlRecord = {
  version: 2
  committed: CompleteOutboundSnapshot | null
  pending?: CompleteOutboundIntent
  finalization?: {
    attempt: HostedOutboundAttempt
    runnerId: string
    runnerLeaseId: string
    retainProtection: boolean
  }
}
