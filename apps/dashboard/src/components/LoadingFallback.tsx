/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LogoText } from '@/assets/Logo'
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Skeleton } from './ui/skeleton'

const LoadingFallback = () => {
  const [showLongLoadingMessage, setShowLongLoadingMessage] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowLongLoadingMessage(true)
    }, 5_000)

    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-4 sm:px-5 2xl:px-0">
          <div className="shrink-0 text-[1.15rem] font-semibold tracking-tight">
            <LogoText />
          </div>
          <div className="hidden items-center gap-2 sm:flex">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-24" />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="hidden h-8 w-28 md:block" />
            <Skeleton className="h-8 w-8 sm:w-32" />
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100svh-3.5rem)] w-full max-w-[1440px] flex-1 flex-col px-4 pb-8 pt-7 sm:px-5 2xl:px-0">
        <div className="mb-6 flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-28" />
        </div>

        <div className="space-y-3">
          <Skeleton className="h-9 w-full max-w-xl" />
          <div className="rounded-sm border border-border">
            <Skeleton className="h-11 rounded-none border-b border-border" />
            <Skeleton className="h-12 rounded-none border-b border-border" />
            <Skeleton className="h-12 rounded-none border-b border-border" />
            <Skeleton className="h-12 rounded-none" />
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <div
            className={`space-y-1 text-center transition-all duration-300 ${
              showLongLoadingMessage ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
            }`}
          >
            <p className="text-sm text-muted-foreground">This is taking longer than expected...</p>
            <p className="text-sm text-muted-foreground">
              If this issue persists, contact us at{' '}
              <a href="mailto:support@boxlite.ai" className="text-primary underline">
                support@boxlite.ai
              </a>
              .
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}

export default LoadingFallback
