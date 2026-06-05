/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxTemplate } from '../entities/box-template.entity'

export class BoxTemplateRemovedEvent {
  constructor(public readonly template: BoxTemplate) {}
}
