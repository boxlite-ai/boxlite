/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { withUpstreamRefs } from '../../image/utils/image-ref.util'

/**
 * A runner's failure as the box records it. A runner's words can name the
 * registry proxy ref a private image was pulled by; the recorded reason names
 * the upstream image the tenant asked for instead.
 */
export function sanitizeBoxError(error: any): { recoverable: boolean; errorReason: string } {
  const { recoverable, errorReason } = parseBoxError(error)
  // JSON a runner did not write can carry anything as its reason.
  return { recoverable, errorReason: typeof errorReason === 'string' ? withUpstreamRefs(errorReason) : errorReason }
}

function parseBoxError(error: any): { recoverable: boolean; errorReason: string } {
  if (typeof error === 'string') {
    try {
      const errObj = JSON.parse(error) as { recoverable: boolean; errorReason: string }
      return { recoverable: errObj.recoverable, errorReason: errObj.errorReason }
    } catch {
      return { recoverable: false, errorReason: error }
    }
  } else if (typeof error === 'object' && error !== null && 'recoverable' in error && 'errorReason' in error) {
    return { recoverable: error.recoverable, errorReason: error.errorReason }
  } else if (typeof error === 'object' && error.message) {
    return parseBoxError(error.message)
  }

  return { recoverable: false, errorReason: String(error) }
}
