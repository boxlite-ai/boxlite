/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// Bounded capability set for BoxAccessGrant. Only `ssh` is accepted today;
// future exposed-port authorization would add `port:<number>`-shaped scopes
// behind a separate Proxy-enforcement design.
export enum BoxAccessGrantScope {
  SSH = 'ssh',
}
