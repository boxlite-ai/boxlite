/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

// The Quickstart "Create a key" step has no name field, so it creates the key
// under a default name. API key names are unique per (org, user) on the backend,
// so re-running the step (e.g. the "Regenerate" button) would 409 ("API key with
// this name already exists"). We keep the clean default for the first attempt
// and switch to a short random suffix on collision — a sequential counter would
// exhaust after a handful of regenerates once every `sdk-quickstart-N` was taken.

const BASE_NAME = 'sdk-quickstart'
const RANDOM_SUFFIX_LEN = 8

// Name for the Nth attempt: `sdk-quickstart` for the first, then a random
// short suffix (~2^40 combos over 8 chars) so repeated retries never need to
// walk a dense number line.
export function buildQuickstartApiKeyName(attempt = 0): string {
  return attempt <= 0 ? BASE_NAME : `${BASE_NAME}-${randomSuffix()}`
}

function randomSuffix(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, RANDOM_SUFFIX_LEN)
  }
  // Non-crypto fallback for very old environments (older jsdom, no globalThis.crypto).
  return Math.random()
    .toString(36)
    .slice(2, 2 + RANDOM_SUFFIX_LEN)
    .padEnd(RANDOM_SUFFIX_LEN, '0')
}

// True when a create failed because the name is already taken (409 Conflict).
// The create goes through the axios interceptor, which wraps the AxiosError in a
// BoxliteError but preserves the original as `.cause`; we also accept a raw
// AxiosError-shaped value and the backend's message as a fallback.
export function isApiKeyNameConflict(error: unknown): boolean {
  const err = error as { cause?: { response?: { status?: number } }; response?: { status?: number }; message?: string }
  const status = err?.cause?.response?.status ?? err?.response?.status
  if (status === 409) return true
  return typeof err?.message === 'string' && err.message.includes('already exists')
}

// Create an API key under the default Quickstart name, retrying with a suffixed
// name on a duplicate-name conflict so the flow never errors on re-run. Any other
// error propagates unchanged.
export async function createApiKeyWithFallbackName<T>(
  create: (name: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await create(buildQuickstartApiKeyName(attempt))
    } catch (error) {
      if (!isApiKeyNameConflict(error)) throw error
      lastError = error
    }
  }
  throw lastError
}
