/*
 * Modified by BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { Box } from '@boxlite-ai/api-client'

export type HandoffBox = Pick<Box, 'id' | 'network'> & { name?: string }

export type Handoff = {
  keyValue: string
  keyName: string
  baselineIds: string[]
  /** When the key was minted. The API expires it after `HANDOFF_LIFETIME_DAYS`;
   *  the store drops it at the same moment so a tab left open past that point
   *  offers a dead credential instead of reminting. */
  issuedAt: number
  /** Recorded once the box is online, so re-entering shows the result instead
   *  of restarting the wait — and does not mint a replacement key. */
  completed?: { id: string; name?: string }
}

/**
 * Where the quickstart's minted key lives: this tab's memory, and nowhere else.
 *
 * It used to be written to `sessionStorage`, so a reload could recover it — the
 * plaintext value is returned exactly once, and losing it strands a live key in
 * the account with nothing to show for it. That is a real cost, and it is the
 * smaller one: a bearer credential at rest in browser storage is readable by
 * anything that reaches the document, which is what CodeQL's
 * `js/clear-text-storage-of-sensitive-data` is for. A reload now mints a fresh
 * key, and the abandoned one expires on its own.
 *
 * A module-level map rather than component state: the SDK walkthrough unmounts
 * the handoff screen, and a remount that could not see the handoff it already
 * made would mint a second key for the same identity. Keyed by user *and*
 * organization, because handing one account a credential minted for another is
 * the failure that scoping guards against.
 */
const handoffs = new Map<string, Handoff>()

// A handoff belongs to one user in one organization; showing the other
// combination a credential minted here is what this identity prevents.
export function handoffIdentity(userId: string, orgId: string) {
  return `${userId}_${orgId}`
}

/**
 * How long the minted key lives. One constant, because it is one policy read
 * from two sides: the console asks the API for this expiry, and the store drops
 * the handoff at the same moment. Two numbers would drift into either offering
 * a dead credential or discarding a live one.
 *
 * The key travels through a third-party coding agent's transcript, so it is
 * scoped and short-lived by construction rather than by warning the user.
 */
export const HANDOFF_LIFETIME_DAYS = 7
export const HANDOFF_LIFETIME_MS = HANDOFF_LIFETIME_DAYS * 24 * 60 * 60 * 1000

export const handoffStore = {
  get: (identity: string, now = Date.now()): Handoff | null => {
    const handoff = handoffs.get(identity)
    if (!handoff) return null
    if (now - handoff.issuedAt > HANDOFF_LIFETIME_MS) {
      handoffs.delete(identity)
      return null
    }
    return handoff
  },
  set: (identity: string, handoff: Handoff) => {
    handoffs.set(identity, handoff)
  },
}

/**
 * Whether a completion recorded earlier still has to be restored onto the
 * screen. Keyed by identity rather than "have we restored at all": with a
 * boolean, switching organizations skipped restoration for the second one, and
 * its finished box is already in `baselineIds`, so polling could not rediscover
 * it either — the screen waited for something that had already happened.
 */
export function shouldRestoreCompletion(state: {
  hydrated: boolean
  restoredFor: string | null
  identity: string | null
}) {
  if (!state.hydrated) return false
  return state.restoredFor !== state.identity
}

/**
 * Whether a key may be minted right now. Pulled out as a pure function because
 * the bug it encodes — issuing while the component still holds the *previous*
 * identity's handoff — mints a live credential, and that is not something to
 * leave provable only by clicking through the UI.
 */
export function shouldIssueKey(state: {
  /** `handoff` has been re-read for the identity currently on screen. */
  hydrated: boolean
  hasHandoff: boolean
  failed: boolean
  hasOrg: boolean
  identity: string | null
  permissionCount: number
  alreadyIssuingForKey: boolean
}) {
  if (!state.identity || !state.hasOrg) return false
  // The gate that matters: a stale `null` handoff from the previous identity
  // reads exactly like "nothing stored for this one".
  if (!state.hydrated) return false
  if (state.hasHandoff || state.failed) return false
  if (state.permissionCount === 0) return false
  return !state.alreadyIssuingForKey
}
