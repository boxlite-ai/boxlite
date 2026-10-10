/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { NetworkMode } from '../enums/network-mode.enum'

/**
 * Translates between the box row's network policy columns (`inboundMode`,
 * `outboundMode`, `outboundAllowNet`) and the Daytona-era flag shape
 * (`public`, `networkBlockAll`, comma-joined `networkAllowList`) that the
 * control-plane DTOs and the runner wire still speak. Keeping the translation
 * in one place is what lets those contracts outlive the columns they named.
 */

export function inboundModeFromPublic(isPublic: boolean | undefined): NetworkMode {
  return isPublic ? NetworkMode.ENABLED : NetworkMode.DISABLED
}

export function isInboundEnabled(mode: NetworkMode): boolean {
  return mode === NetworkMode.ENABLED
}

export function outboundModeFromBlockAll(blockAll: boolean): NetworkMode {
  return blockAll ? NetworkMode.DISABLED : NetworkMode.ENABLED
}

export function isOutboundBlocked(mode: NetworkMode): boolean {
  return mode === NetworkMode.DISABLED
}

/** Comma-joined allowlist → entries; `undefined` when nothing is listed. */
export function allowNetFromList(list: string | undefined): string[] | undefined {
  const entries = (list ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.length > 0 ? entries : undefined
}

/** Entries → the comma-joined shape; `undefined` when nothing is listed. */
export function allowListFromAllowNet(allowNet: string[] | null | undefined): string | undefined {
  return allowNet && allowNet.length > 0 ? allowNet.join(',') : undefined
}
