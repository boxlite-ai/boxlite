/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { formatDuration } from '@/lib/apps/format'
import { useEffect, useState } from 'react'

/** "0:42" since `since`, ticking every second; null without a start time. */
export function useElapsed(since: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!since) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [since])
  if (!since) return null
  return formatDuration(Math.max(0, now - Date.parse(since)))
}
