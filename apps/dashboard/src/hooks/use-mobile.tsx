/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useMatchMedia } from './useMatchMedia'

const MOBILE_BREAKPOINT = 768
const COMPACT_BREAKPOINT = 1200

export function useIsMobile() {
  return useMatchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
}

export function useIsCompactScreen() {
  return useMatchMedia(`(max-width: ${COMPACT_BREAKPOINT - 1}px)`)
}
