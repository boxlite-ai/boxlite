/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export const DEFAULT_AUTO_STOP_SECONDS = 900
export const AUTO_STOP_DISABLED = 0

// The preview proxy refreshes a running box's idle timer on a fixed 50s poll
// (apps/proxy/pkg/proxy/get_box_target.go), so an idle window shorter than one
// poll lapses between two renewals and the box is reaped while traffic is still
// flowing. Sub-minute windows were also unreachable before lifecycle intervals
// moved from minutes to seconds, so no valid caller depended on them.
export const MIN_AUTO_STOP_SECONDS = 60

export const AUTO_DELETE_DISABLED = 0
export const DEFAULT_AUTO_RESUME = true
