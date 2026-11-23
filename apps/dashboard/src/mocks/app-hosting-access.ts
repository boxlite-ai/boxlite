/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { setAppHostingIntroSeen } from '@/lib/apps/intro'

export function configureAppHostingFixture() {
  const access = new URLSearchParams(window.location.search).get('appHosting')
  if (access === 'enabled' || access === 'restricted') setAppHostingIntroSeen(access === 'enabled')
}
