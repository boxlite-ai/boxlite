/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box } from '../entities/box.entity'

export class BoxInboundModeUpdatedEvent {
  constructor(
    public readonly box: Box,
    public readonly wasEnabled: boolean,
    public readonly isEnabled: boolean,
  ) {}
}
