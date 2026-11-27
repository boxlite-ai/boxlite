/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
/** Server-only proof that an exception occurred before the requested business effect. */
export const REPLAY_NO_EFFECT = Symbol('replay-no-effect')

export function noEffect<T extends Error>(error: T): T {
  Object.defineProperty(error, REPLAY_NO_EFFECT, { value: true })
  return error
}

export function hasNoEffect(error: unknown): boolean {
  return error instanceof Error && REPLAY_NO_EFFECT in error && error[REPLAY_NO_EFFECT] === true
}
