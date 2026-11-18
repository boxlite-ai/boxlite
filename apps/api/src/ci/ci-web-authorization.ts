/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest()
export function webAuthorization(id: string) {
  const state = id + '.' + randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  return { state, verifier, stateHash: hash(state).toString('hex'), challenge: hash(verifier).toString('base64url') }
}
export function matchesWebState(id: string, state: string, expected: string | null): boolean {
  return (
    typeof state === 'string' &&
    state.startsWith(id + '.') &&
    /^[a-f0-9]{64}$/.test(expected || '') &&
    timingSafeEqual(hash(state), Buffer.from(expected!, 'hex'))
  )
}
