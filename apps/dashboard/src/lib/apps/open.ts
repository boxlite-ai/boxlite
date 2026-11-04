/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { handleApiError } from '@/lib/error-handling'
import { useAppsScope } from './client'

/** A one-time browser ticket keeps the platform bearer out of the application's URL. */
export function useOpenApp() {
  const { client } = useAppsScope()
  return async (appId: string, env: string, next?: string): Promise<void> => {
    const tab = window.open('about:blank', '_blank')
    try {
      const { data } = await client.post<{ url: string }>(
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
}
