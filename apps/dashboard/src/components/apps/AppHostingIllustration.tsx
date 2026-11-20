/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { cn } from '@/lib/utils'

/** Console wireframes: an idea becomes an app running inside a cloud-hosted Box. */
export function AppHostingIllustration({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <svg
      viewBox={compact ? '220 -10 350 310' : '0 0 640 300'}
      aria-hidden="true"
      className={cn('w-full text-muted-foreground', className)}
      fill="none"
    >
      <g stroke="currentColor" strokeWidth="1" opacity="0.13">
        <path d="M100 205 310 85M140 228 350 108M180 251 390 131M220 274 430 154M260 297 470 177M100 205 260 297M140 182 300 274M180 159 340 251M220 136 380 228M260 113 420 205M300 90 460 182" />
        <path d="M78 95v14m-7-7h14M564 104v14m-7-7h14M520 258v14m-7-7h14" />
      </g>
      <g stroke="currentColor" strokeWidth="1.5" opacity="0.45">
        <path d="M332 102h-18a27 27 0 0 1-3-54 44 44 0 0 1 84-9 30 30 0 0 1 42 36 20 20 0 0 1-5 39h-20" />
        <path d="m275 170 79-46 79 46-79 46-79-46Zm0 0v59l79 46 79-46v-59m-79 46v59" />
      </g>
      <g stroke="hsl(var(--brand))" strokeWidth="1.5">
        <path d="m305 164 49-28 49 28-49 29-49-29Z" fill="hsl(var(--brand) / 0.12)" />
        <path d="m305 164 49 29v57l-49-28v-58Z" fill="hsl(var(--brand) / 0.06)" />
        <path d="m354 193 49-29v58l-49 28v-57Z" fill="hsl(var(--brand) / 0.18)" />
        <path d="m320 192 19 11m-19 0 12 7m35-7 20-11m-20 22 14-8" />
      </g>
      <g stroke="currentColor" strokeWidth="1.5">
        <path d="M414 122V75h118v84h-84" fill="hsl(var(--background))" />
        <path d="M414 91h118m-104-8h4m5 0h4m5 0h4" opacity="0.6" />
        <path d="M429 106h32v32h-32zm44 2h44m-44 11h32m-32 11h39" opacity="0.35" />
      </g>
      {!compact && (
        <g strokeWidth="1.5">
          <g stroke="currentColor">
            <path d="M105 125a23 23 0 1 1 38 17c-6 5-7 10-7 15h-20c0-5-1-10-7-15a23 23 0 0 1-4-17Zm12 40h18m-15 7h12" />
            <path d="M126 88V76m-34 25-9-7m77 7 9-7" opacity="0.45" />
          </g>
          <path d="M154 153h27l20 22h58m-9-6 9 6-9 6" stroke="hsl(var(--brand))" strokeDasharray="4 5" />
          <path d="m203 116-8 7 8 7m20-14 8 7-8 7m-9-18-5 35" stroke="hsl(var(--brand))" />
        </g>
      )}
    </svg>
  )
}
