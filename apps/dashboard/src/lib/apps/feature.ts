/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// The Apps surface is a design mock: it has data only under MSW. Outside mock
// mode it stays hidden unless a reviewer opts in, so a real deployment never
// shows a nav item that 404s against the API.
export function isAppsPreviewEnabled(): boolean {
  if (import.meta.env.VITE_ENABLE_MOCKING === 'true') return true
  try {
    return globalThis.localStorage?.getItem('apps-preview') === '1'
  } catch {
    return false
  }
}
