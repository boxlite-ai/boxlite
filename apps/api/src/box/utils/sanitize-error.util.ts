/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { withoutRegistryProxy } from '../../image/utils/image-ref.util'

const FILESTORE_PREPARE_PREFIX =
  /FILESTORE_VOLUME_PREPARE_FAILED: failed to prepare filestore volume (\S+) on instance (\S+) for box (\S+):/

function withoutFilestoreMountTarget(errorReason: string): string {
  const match = errorReason.match(FILESTORE_PREPARE_PREFIX)
  if (match) {
    return `FILESTORE_VOLUME_PREPARE_FAILED: failed to prepare filestore volume ${match[1]} on instance ${match[2]} for box ${match[3]}`
  }
  if (errorReason.includes('FILESTORE_VOLUME_PREPARE_FAILED')) {
    return 'FILESTORE_VOLUME_PREPARE_FAILED: Filestore volume preparation failed'
  }
  return errorReason
}

/**
 * A runner's failure as the box records it. A runner's words can name the
 * registry proxy a private image was pulled through; the recorded reason names
 * the upstream image the tenant asked for instead, and never the proxy's
 * address. Filestore preparation errors likewise keep resolved NFS targets
 * out of the public reason while retaining their stable code and logical IDs.
 */
export function sanitizeBoxError(error: any): { recoverable: boolean; errorReason: string } {
  const { recoverable, errorReason } = parseBoxError(error)
  // JSON a runner did not write can carry anything as its reason.
  return {
    recoverable,
    errorReason: typeof errorReason === 'string' ? withoutFilestoreMountTarget(withoutRegistryProxy(errorReason)) : errorReason,
  }
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
