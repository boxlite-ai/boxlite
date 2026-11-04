/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../enums/box-state.enum'

export const BOX_WARM_POOL_UNASSIGNED_ORGANIZATION = '00000000-0000-0000-0000-000000000000'

/**
 * The states a stopped box holds while a snapshot job owns its disk. They sit
 * outside the desired-state machine: the desired state stays STOPPED, nothing
 * is pending, and the job's settlement — not the sync loop — moves the box
 * back to STOPPED. Deletion is the one change they admit.
 */
export const SNAPSHOT_OPERATION_STATES: readonly BoxState[] = [BoxState.EXPORTING, BoxState.IMPORTING]
