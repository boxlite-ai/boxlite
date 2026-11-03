/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** Public hosted capabilities shared by REST and MCP; contains no deployment secrets. */
export function getHostedBoxConfig() {
  return {
    capabilities: {
      snapshots_enabled: false,
      clone_enabled: false,
      export_enabled: false,
      import_enabled: false,
      inbound_update_enabled: true,
    },
  }
}
