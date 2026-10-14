/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NetworkMode } from '../enums/network-mode.enum'

/** A stored enabled flag → the `/v1` NetworkSpec `mode` the wire speaks. */
export function networkMode(enabled: boolean): NetworkMode {
  return enabled ? NetworkMode.ENABLED : NetworkMode.DISABLED
}
