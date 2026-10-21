/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// The Apps screens talk to the Micro-cloud control plane's console API
// (VITE_APPS_API_URL, e.g. /console/api). A build that sets it is the Apps
// console: Apps is the whole product there and the rest of the dashboard is
// not shown. Elsewhere Apps stays hidden unless a reviewer opts in, so a real
// deployment never shows a nav item that 404s.

export function appsApiUrl(): string {
  return (import.meta.env.VITE_APPS_API_URL || '/console/api').replace(/\/+$/, '')
}

/** This build is the standalone Apps console served by the control plane. */
export function isAppsConsole(): boolean {
  return !!import.meta.env.VITE_APPS_API_URL
}

/** Where the console signs out (the control plane clears its cookie). */
export function consoleLogoutUrl(): string {
  return appsApiUrl().replace(/\/api$/, '') + '/logout'
}

export function isAppsPreviewEnabled(): boolean {
  if (isAppsConsole()) return true
  try {
    return globalThis.localStorage?.getItem('apps-preview') === '1'
  } catch {
    return false
  }
}
