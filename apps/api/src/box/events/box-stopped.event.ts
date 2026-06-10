/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'

export class BoxStoppedEvent {
  constructor(
    public readonly box: Box,
    public readonly force?: boolean,
  ) {}
}
