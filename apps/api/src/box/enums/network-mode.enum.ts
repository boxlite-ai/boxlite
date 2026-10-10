/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// One vocabulary for both directions of a box's network policy, matching the
// `mode` values of the `/v1` NetworkSpec and the CLI's --network / --inbound
// flags. Inbound `enabled` means the services the box exposes are reachable
// through the proxy without signing in; outbound `disabled` means no egress.
export enum NetworkMode {
  ENABLED = 'enabled',
  DISABLED = 'disabled',
}
