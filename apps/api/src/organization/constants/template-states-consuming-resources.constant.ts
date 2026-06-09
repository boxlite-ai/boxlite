/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplateState } from '../../sandbox/enums/box-template-state.enum'

export const TEMPLATE_STATES_CONSUMING_RESOURCES: BoxTemplateState[] = [
  BoxTemplateState.BUILDING,
  BoxTemplateState.PENDING,
  BoxTemplateState.PULLING,
  BoxTemplateState.ACTIVE,
]
