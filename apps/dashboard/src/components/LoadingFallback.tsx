/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import { useEffect, useState } from 'react'

// Terminal-style boot screen so the loading state matches the console's
// pixel/mono aesthetic instead of a generic skeleton shell.
const LoadingFallback = () => {
  const [showLongLoadingMessage, setShowLongLoadingMessage] = useState(false)
  const [dotCount, setDotCount] = useState(1)

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowLongLoadingMessage(true)
    }, 5_000)

    return () => clearTimeout(timer)
  }, [])

  // Typewriter ellipsis: cycle 1 → 2 → 3 dots and back, a touch retro.
  useEffect(() => {
    const id = setInterval(() => setDotCount((d) => (d % 3) + 1), 400)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-10 bg-background px-6 text-center font-mono text-foreground">
      <LogoText className="h-14 w-auto" />

      <div className="flex items-center gap-3 text-[17px] uppercase tracking-[2.5px] text-muted-foreground">
        <span
          className="inline-block size-[11px] animate-pulse bg-brand"
          style={{ boxShadow: '0 0 12px hsl(var(--brand))' }}
        />
        <span>booting console</span>
        {/* typewriter ellipsis: 1 → 2 → 3 dots, looping */}
        <span className="inline-block w-[1.6em] text-left" aria-hidden="true">
          {'.'.repeat(dotCount)}
        </span>
      </div>

      {showLongLoadingMessage && (
        <div className="space-y-1 text-[13px] normal-case tracking-normal text-muted-foreground">
          <p>taking longer than expected…</p>
          <p>
            if it persists, ping{' '}
            <a href="mailto:support@boxlite.ai" className="text-brand underline underline-offset-2">
              support@boxlite.ai
            </a>
          </p>
        </div>
      )}
    </div>
  )
}

export default LoadingFallback
