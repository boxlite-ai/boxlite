/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { cn } from '@/lib/utils'
import { relTime } from '@/lib/apps/format'
import type { AppPreview } from '@/lib/apps/types'
import type { ReactNode } from 'react'

// Visual pieces the App pages add, in the console's language: a small bordered
// uppercase tag (as "CURRENT" on plans) and the production screenshot the proxy
// captures after a deployment. The Overview's traffic chart is TrafficPanel.tsx.

/** Small bordered uppercase tag, as "CURRENT" / "BY REQUEST" on the plan cards. */
export function Tag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'brand' | 'good' | 'bad' | 'warn'
}) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center whitespace-nowrap border px-[6px] py-[2px] font-mono text-[9px] uppercase leading-none tracking-[1px]',
        tone === 'neutral' && 'border-border text-muted-foreground',
        tone === 'brand' && 'border-brand/50 text-brand',
        tone === 'good' && 'border-success/50 text-success',
        tone === 'bad' && 'border-destructive/50 text-destructive',
        tone === 'warn' && 'border-warning/50 text-warning',
      )}
    >
      {children}
    </span>
  )
}

/**
 * What the live URL showed at its last capture: the control plane renders the
 * app when a deployment goes live (and again when the picture is a day old).
 * Only a real capture is shown: no frame, no placeholder. Click opens the app.
 * The caption names the deployment and the time; it turns amber when the
 * picture is of an older deployment than the one serving now.
 */
export function LivePreview({
  preview,
  liveRelease,
  onOpen,
  name,
}: {
  preview: AppPreview
  liveRelease: string | null
  onOpen: () => void
  name: string
}) {
  const stale = preview.releaseId !== liveRelease
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${name}`}
        className="block border border-border outline-none transition-colors hover:border-brand focus-visible:ring-2 focus-visible:ring-brand/35"
      >
        <img
          src={preview.src}
          alt={`${name} at ${preview.releaseId}`}
          className="aspect-[16/10] w-full object-cover object-top"
          loading="lazy"
        />
      </button>
      <figcaption
        className={cn('font-mono text-meta', stale ? 'text-warning' : 'text-muted-foreground')}
        title={new Date(preview.capturedAt).toLocaleString()}
      >
        {stale ? `Screenshot from ${preview.releaseId}` : preview.releaseId} · captured {relTime(preview.capturedAt)}
      </figcaption>
    </figure>
  )
}
