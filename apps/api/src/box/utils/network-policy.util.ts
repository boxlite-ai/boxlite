/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NetworkMode } from '../enums/network-mode.enum'

/**
 * Translates between the box row's network policy columns (`inboundMode`,
 * `outboundMode`, `outboundAllowNet`) and the Daytona-era flag shape
 * (`networkBlockAll`, comma-joined `networkAllowList`) that the runner wire
 * still speaks. Keeping the translation in one place is what lets that
 * contract outlive the columns it named.
 */

export function isInboundEnabled(mode: NetworkMode): boolean {
  return mode === NetworkMode.ENABLED
}

export function outboundModeFromBlockAll(blockAll: boolean): NetworkMode {
  return blockAll ? NetworkMode.DISABLED : NetworkMode.ENABLED
}

export function isOutboundBlocked(mode: NetworkMode): boolean {
  return mode === NetworkMode.DISABLED
}

/** Entries → the comma-joined shape; `undefined` when nothing is listed. */
export function allowListFromAllowNet(allowNet: string[] | null | undefined): string | undefined {
  return allowNet && allowNet.length > 0 ? allowNet.join(',') : undefined
}
