/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */

import { isAxiosError } from 'axios'

type SshPreferences = { keyPath?: string; hostPublicKey?: string }

/** Read optional, nonsecret path preferences; unavailable storage never blocks connecting. */
export function readSshPreferences(key?: string): SshPreferences {
  try {
    const value = key ? JSON.parse(sessionStorage.getItem(key) ?? '{}') : {}
    return {
      keyPath: typeof value?.keyPath === 'string' ? value.keyPath : '',
      hostPublicKey: typeof value?.hostPublicKey === 'string' ? value.hostPublicKey : '',
    }
  } catch {
    return {}
  }
}

/** Persist only in an authenticated scope; callers bind a validated path to its host identity. */
export function rememberSshPreferences(key: string | undefined, update: SshPreferences) {
  if (!key) return
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...readSshPreferences(key), ...update }))
  } catch {
    // Storage is optional; blocked storage must not prevent a connection.
  }
}

/** Classify actionable failures without interpreting partial diagnostics as permission to replace keys. */
export function sshFailureReason(error: unknown): 'missing-config' | 'authentication' | 'permission' | 'unknown' {
  if (!isAxiosError(error)) return 'unknown'
  if (error.response?.status === 401) return 'authentication'
  if (error.response?.status === 403) return 'permission'
  const data = error.response?.data
  let message = data?.error?.message ?? data?.message
  if (typeof message !== 'string') return 'unknown'
  // map_tonic_err adds the operation and tonic's Display envelope to guest errors.
  const wrapped =
    /^(?:invalid state: )?SSH enable: status: FailedPrecondition, message: "([^"\\]*)", details: \[\], metadata: MetadataMap \{ headers: \{[^\r\n]*\} \}$/.exec(
      message,
    )
  if (wrapped) message = wrapped[1]
  if (
    ['SSH configuration is required', 'stored SSH configuration is missing', 'SSH has no saved configuration'].includes(
      message,
    )
  )
    return 'missing-config'
  return 'unknown'
}
