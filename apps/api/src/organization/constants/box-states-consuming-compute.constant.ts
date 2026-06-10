/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'

export const BOX_STATES_CONSUMING_COMPUTE: BoxState[] = [
  BoxState.CREATING,
  BoxState.RESTORING,
  BoxState.STARTED,
  BoxState.STARTING,
  BoxState.STOPPING,
  BoxState.PENDING_BUILD,
  BoxState.BUILDING_SNAPSHOT,
  BoxState.UNKNOWN,
  BoxState.PULLING_SNAPSHOT,
]
