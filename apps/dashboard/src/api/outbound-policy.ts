/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { z } from 'zod'

const phase = z.enum(['confirmed', 'pending', 'uncertain'])
const revision = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const snapshot = z.object({
  revision,
  admission: z.enum(['legacy', 'extended_ipv4']),
  policy: z.object({
    mode: z.enum(['enabled', 'disabled']),
    allow_net: z.array(z.string()).max(64),
    deny_net: z.array(z.string()).max(64),
  }),
})
const status = z.object({
  persisted: snapshot.nullable(),
  runtime_persisted: snapshot.nullable(),
  observed: z.object({ snapshot, application_state: phase }).nullable(),
  application_state: phase,
  pending_revision: revision.optional(),
})

export type BoxOutboundPolicyStatus = z.infer<typeof status>
type Snapshot = z.infer<typeof snapshot>

function sameList(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameSnapshot(left: Snapshot, right: Snapshot) {
  return (
    left.revision === right.revision &&
    left.admission === right.admission &&
    left.policy.mode === right.policy.mode &&
    sameList(left.policy.allow_net, right.policy.allow_net) &&
    sameList(left.policy.deny_net, right.policy.deny_net)
  )
}

export function readBoxOutboundPolicyStatus(value: unknown): BoxOutboundPolicyStatus {
  const result = status.parse(value)
  const { persisted, runtime_persisted, observed, pending_revision } = result
  if (
    result.application_state === 'confirmed' &&
    (!persisted ||
      !runtime_persisted ||
      !observed ||
      pending_revision ||
      observed.application_state !== 'confirmed' ||
      !sameSnapshot(persisted, runtime_persisted) ||
      !sameSnapshot(persisted, observed.snapshot))
  ) {
    return { ...result, application_state: 'uncertain' }
  }
  return result
}
