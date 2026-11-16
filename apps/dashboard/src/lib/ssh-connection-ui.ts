/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */

import { isAxiosError } from 'axios'

/** Keep missing configuration distinct from authentication, permission and transport failures. */
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
