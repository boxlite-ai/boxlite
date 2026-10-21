/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { handleApiError } from '@/lib/error-handling'
import { appsClient } from './client'

/**
 * "Open app": the control plane mints a one-time ticket that signs this browser in to the env's
 * own origin (private and org apps included), and the new tab follows it. The tab is opened
 * before the request so the browser does not treat it as a popup.
 */
export async function openApp(appId: string, env: string, next?: string): Promise<void> {
  const tab = window.open('about:blank', '_blank')
  try {
    const { data } = await appsClient.post<{ url: string }>(
      `/apps/${encodeURIComponent(appId)}/open-ticket`,
      next ? { next } : undefined,
      { params: { env } },
    )
    if (tab) tab.location.href = data.url
    else window.location.assign(data.url)
  } catch (error) {
    tab?.close()
    handleApiError(error, 'Could not open the app')
  }
}
