/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

/** Tab-local fixtures persist while navigating between the App list and details. */
export function configureAppHostingFixture() {
  const access = new URLSearchParams(window.location.search).get('appHosting')
  if (access !== 'enabled' && access !== 'restricted') return
  try {
    sessionStorage.setItem('mock-app-hosting-access', access)
  } catch {
    // Storage-restricted browsers keep the default early-access presentation.
  }
}
