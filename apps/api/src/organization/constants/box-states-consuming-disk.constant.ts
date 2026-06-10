/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'
import { BOX_STATES_CONSUMING_COMPUTE } from './box-states-consuming-compute.constant'

export const BOX_STATES_CONSUMING_DISK: BoxState[] = [
  ...BOX_STATES_CONSUMING_COMPUTE,
  BoxState.STOPPED,
  BoxState.ARCHIVING,
  BoxState.RESIZING,
]
