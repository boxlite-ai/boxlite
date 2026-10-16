/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The box row stores the outbound allowlist as entries (`outboundAllowNet`),
 * while the control-plane DTO and the runner wire still speak the Daytona-era
 * comma-joined `networkAllowList`. Keeping the join in one place is what lets
 * those contracts outlive the column they named.
 */

/** Entries → the comma-joined shape; `undefined` when nothing is listed. */
export function allowListFromAllowNet(allowNet: string[] | null | undefined): string | undefined {
  return allowNet && allowNet.length > 0 ? allowNet.join(',') : undefined
}
