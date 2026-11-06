/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */

import { isAxiosError } from 'axios'

type SshPreferences = { keyPath?: string; hostPublicKey?: string }

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

export function rememberSshPreferences(key: string | undefined, update: SshPreferences) {
  if (!key) return
  try {
    sessionStorage.setItem(key, JSON.stringify({ ...readSshPreferences(key), ...update }))
  } catch {
    // Storage is optional; blocked storage must not prevent a connection.
  }
}

export function sshFailureReason(error: unknown): 'missing-config' | 'authentication' | 'permission' | 'unknown' {
  if (!isAxiosError(error)) return 'unknown'
  if (error.response?.status === 401) return 'authentication'
  if (error.response?.status === 403) return 'permission'
  const data = error.response?.data
  const message = data?.error?.message ?? data?.message
  // A conflict can also mean a stopped box. Only these server messages establish absence.
  if (
    typeof message === 'string' &&
    /\b(?:SSH configuration is required|stored SSH configuration is missing|SSH has no saved configuration)\b/.test(
      message,
    )
  )
    return 'missing-config'
  return 'unknown'
}
