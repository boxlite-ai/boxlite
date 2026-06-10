/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { WarmPool } from '../entities/warm-pool.entity'

export class WarmPoolTopUpRequested {
  constructor(public readonly warmPool: WarmPool) {}
}
