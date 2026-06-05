/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplate } from '../entities/box-template.entity'
import { BoxTemplateState } from '../enums/box-template-state.enum'

export class BoxTemplateStateUpdatedEvent {
  constructor(
    public readonly template: BoxTemplate,
    public readonly oldState: BoxTemplateState,
    public readonly newState: BoxTemplateState,
  ) {}
}
