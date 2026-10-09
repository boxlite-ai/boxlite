/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** A failed pull its registry explained, sorted by what the caller can do about it. */
export type PullFailure = {
  /** `missing`: the registry does not have it. `refused`: it will not serve it to this caller. */
  kind: 'missing' | 'refused'
  /** The registry's own codes, as it sent them. */
  codes: string[]
}

// The runtime writes the registry's error codes into a failed pull's message,
// `failed to pull manifest [MANIFEST_UNKNOWN]: …`, and nothing else in that
// message is stable: what follows the colon is each registry's own wording.
const REGISTRY_CODES = /failed to pull [^[\n]*? \[([A-Z_]+(?:, [A-Z_]+)*)\]: /g

const MISSING = new Set(['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'])
const REFUSED = new Set(['DENIED', 'UNAUTHORIZED'])

/**
 * What a runner's pull error says, when its registry said something a tenant
 * can act on; undefined for everything else, including an error from a
 * runtime that does not report codes at all.
 *
 * Every code has to agree. A pull that tried two registries, one without the
 * image and one refusing it, has no single thing to tell the caller, and is
 * better left in the runtime's words than summed up wrongly.
 */
export function pullFailureOf(reason: string): PullFailure | undefined {
  // A runner's JSON can carry anything as its reason, a missing one included.
  if (typeof reason !== 'string') {
    return undefined
  }
  const codes = [...new Set([...reason.matchAll(REGISTRY_CODES)].flatMap((match) => match[1].split(', ')))]
  if (codes.length === 0) {
    return undefined
  }
  if (codes.every((code) => MISSING.has(code))) {
    return { kind: 'missing', codes }
  }
  if (codes.every((code) => REFUSED.has(code))) {
    return { kind: 'refused', codes }
  }
  return undefined
}
