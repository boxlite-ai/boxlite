/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NetworkMode } from '../enums/network-mode.enum'

/** A stored enabled flag → the `/v1` NetworkSpec `mode` the wire speaks. */
export function networkMode(enabled: boolean): NetworkMode {
  return enabled ? NetworkMode.ENABLED : NetworkMode.DISABLED
}

/**
 * The box row stores the outbound allowlist as entries (`outboundAllowNet`),
 * while the control-plane DTO still speaks the Daytona-era comma-joined
 * `networkAllowList`. Keeping the join in one place is what lets that contract
 * outlive the column it named.
 */

/** Entries → the comma-joined shape; `undefined` when nothing is listed. */
export function allowListFromAllowNet(allowNet: string[] | null | undefined): string | undefined {
  return allowNet && allowNet.length > 0 ? allowNet.join(',') : undefined
}
