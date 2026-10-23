/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArrowUpRight, RefreshCw } from '@/components/ui/icon'
import { APPS_SCOPE } from '@/hooks/queries/useAppsQuery'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { appsClient, downloadUrl } from '@/lib/apps/client'
import { handleApiError } from '@/lib/error-handling'
import { useQueryClient } from '@tanstack/react-query'
import { actorName, capitalize, formatBytes, relTime, STATUS } from '@/lib/apps/format'
import { openApp } from '@/lib/apps/open'
import type { AppDetail, AppRelease, AppTab, BoxUsage } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { DeployProgress } from './DeployProgress'
import { CopyIconButton } from './spec'

// The top of the Overview: what is live, the app as visitors see it in a browser frame with its
// address, next to the deployment that put it there. Every fact appears once; the header already
// says the app's state.

const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

/** The isometric cube of boxlite.ai, as an outline (the site's blEdge cube). */
function IsoCube({ size = 22, tone = 'brand' }: { size?: number; tone?: 'brand' | 'muted' }) {
  const stroke = tone === 'brand' ? 'hsl(var(--brand))' : 'hsl(var(--muted-foreground))'
  const fill = tone === 'brand' ? '0,176,240' : '150,158,170'
  return (
    <svg width={size} height={size * 1.1} viewBox="-11 -7 22 24" aria-hidden="true" className="shrink-0">
      <path d="M0,-6 L10,0 L0,6 L-10,0 Z" fill={`rgba(${fill},.25)`} stroke={stroke} strokeWidth="1.1" />
      <path d="M10,0 L10,10 L0,16 L0,6 Z" fill={`rgba(${fill},.12)`} stroke={stroke} strokeWidth="1.1" />
      <path d="M-10,0 L-10,10 L0,16 L0,6 Z" fill={`rgba(${fill},.05)`} stroke={stroke} strokeWidth="1.1" />
    </svg>
  )
}

/** The app as visitors see it: its last screenshot in a browser frame whose address bar is the URL. */
export function LiveCard({
  app,
  active,
  failing,
  onGoTo,
}: {
  app: AppDetail
  active: AppRelease | null
  failing: boolean
  onGoTo: (tab: AppTab, section?: string, extra?: Record<string, string>) => void
}) {
  const open = () => void openApp(app.id, app.environment)
  // A failing app gets no screenshot: the last good picture would say all is well.
  const preview = app.preview && !failing ? { ...app.preview, src: downloadUrl(app.preview.src) } : null
  const asleep = app.status === 'sleeping'
  return (
    // One card: the app as visitors see it on the left, what is live and its facts on the right.
    <section className="grid border border-border bg-card lg:grid-cols-[minmax(0,500px)_minmax(0,1fr)]">
      <figure className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
        {/* The browser frame: the address once, here, with copy and open. */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex gap-[5px]" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-[7px] rounded-full bg-border" />
            ))}
          </span>
          <span className="ml-2 flex min-w-0 flex-1 items-center gap-2 bg-background/60 px-2 py-[3px] font-mono text-[12px]">
            <span className="size-[6px] shrink-0" style={{ background: asleep ? STATUS.stopped : STATUS.running }} />
            <span className="min-w-0 truncate text-muted-foreground" title={app.url}>
              {host(app.url)}
            </span>
          </span>
          <CopyIconButton text={app.url} title="Copy URL" />
          {app.activeRelease && <RetakeButton app={app} />}
          {app.activeRelease && (
            <button
              type="button"
              onClick={open}
              aria-label={`Open ${app.name}`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowUpRight className="size-3.5" />
            </button>
          )}
        </div>
        {preview ? (
          <button type="button" onClick={open} title={`Open ${app.name}`} className="block w-full">
            <img
              src={preview.src}
              alt={`${app.name} at ${preview.releaseId}`}
              className={cn('aspect-[16/10] w-full object-cover object-top', asleep && 'opacity-60 grayscale-[35%]')}
              loading="lazy"
            />
          </button>
        ) : (
          <div className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_50%_45%,hsl(var(--brand)/0.10),transparent_60%)]">
            <IsoCube size={44} tone={failing ? 'muted' : 'brand'} />
            <span className="font-mono text-[12px] text-muted-foreground">
              {failing ? 'Not serving right now' : 'A picture appears after the next deployment'}
            </span>
          </div>
        )}
      </figure>

      <div className="flex min-w-0 flex-col gap-3 px-7 py-6">
        <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-foreground">
          <span className={failing ? 'text-destructive' : 'text-brand'}>▸</span>{' '}
          {failing ? 'Live · not healthy' : asleep ? 'Live · asleep until the next visit' : 'Live now'}
        </span>
        {active ? (
          <>
            <button
              type="button"
              onClick={() => onGoTo('deployments', undefined, { deployment: String(active.number) })}
              className="line-clamp-2 text-left font-display text-[20px] font-semibold leading-snug tracking-[-0.3px] text-foreground hover:underline"
            >
              {active.summary}
            </button>
            <span className="font-mono text-[13px] text-muted-foreground">
              {active.id} · deployed{' '}
              <span title={new Date(active.createdAt).toLocaleString('en-US')}>{relTime(active.createdAt)}</span> by{' '}
              {actorName(active.by)}
            </span>
          </>
        ) : (
          <span className="font-display text-[24px] font-semibold text-foreground">Nothing live yet</span>
        )}
        {app.deploying && !app.activeRelease && (
          <button type="button" className="text-left" onClick={() => onGoTo('deployments')}>
            <DeployProgress deploying={app.deploying} />
          </button>
        )}
        {preview && preview.releaseId !== app.activeRelease && (
          <span className="font-mono text-[12px] text-warning">
            Picture from {preview.releaseId}, captured {relTime(preview.capturedAt)}
          </span>
        )}
        {app.previewAttempt?.failed && !app.previewAttempt.taking && (
          <span className="font-mono text-[12px] text-muted-foreground">
            New picture failed {relTime(app.previewAttempt.failed.at)}: {app.previewAttempt.failed.reason}
          </span>
        )}
        <MetaGrid app={app} />
      </div>
    </section>
  )
}

/** The app's basic facts, compact: label over value, two columns. */
/** Below this share free, the Box is near its limit (the control plane says so under Problems). */
const LOW_FREE_SHARE = 0.1

/** `412 MB of 2.0 GB used`, red when less than a tenth is left. */
function usageRow(label: string, total: number, free: number, title: string) {
  const low = total > 0 && free < total * LOW_FREE_SHARE
  return {
    label,
    title,
    value: (
      <span className={cn(low && 'text-destructive')}>
        {formatBytes(total - free)} of {formatBytes(total)} used
      </span>
    ),
  }
}

function usageRows(usage: BoxUsage | null | undefined) {
  if (!usage) return []
  return [
    usageRow('Memory', usage.memoryTotalBytes, usage.memoryAvailableBytes, 'Memory in use by the whole Box, the app and the platform'),
    usageRow('Disk', usage.diskTotalBytes, usage.diskFreeBytes, 'The Box disk: the app, its volumes and recent versions'),
  ]
}

function MetaGrid({ app }: { app: AppDetail }) {
  const runtime = app.runtime
    ? `${app.runtime.image} · ${app.runtime.size}${
        app.runtime.cpus !== null && app.runtime.memoryMib !== null
          ? ` (${app.runtime.cpus} CPU, ${app.runtime.memoryMib / 1024} GB)`
          : ''
      }`
    : null
  const services = app.services.map((s) => ({
    name: s.name,
    color:
      s.state === 'asleep'
        ? STATUS.stopped
        : s.state === 'running' && s.health !== 'unhealthy'
          ? STATUS.running
          : s.state === 'failed' || s.health === 'unhealthy'
            ? STATUS.error
            : STATUS.idle,
  }))
  const rows: { label: string; value: ReactNode; title?: string }[] = [
    {
      label: 'App id',
      value: (
        <span className="inline-flex items-center gap-1.5">
          {app.appId}
          <CopyIconButton text={app.appId} title="Copy app id" />
        </span>
      ),
    },
    { label: 'Created', value: relTime(app.createdAt), title: new Date(app.createdAt).toLocaleString('en-US') },
    ...(runtime ? [{ label: 'Runtime', value: runtime }] : []),
    ...usageRows(app.box?.usage),
    ...(services.length
      ? [
          {
            label: 'Services',
            value: (
              <span className="inline-flex flex-wrap gap-x-3">
                {services.map((s) => (
                  <span key={s.name} className="inline-flex items-center gap-1.5">
                    <span className="size-[6px]" style={{ background: s.color }} />
                    {s.name}
                  </span>
                ))}
              </span>
            ),
          },
        ]
      : []),
    ...(app.database ? [{ label: 'Database', value: app.database.engine }] : []),
  ]
  return (
    <dl className="mt-auto grid grid-cols-2 gap-x-8 gap-y-4 border-t border-border/60 pt-5 font-mono">
      {rows.map((r) => (
        <div key={r.label} className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[10px] uppercase tracking-[1.5px] text-muted-foreground">{r.label}</dt>
          <dd className="min-w-0 truncate text-[13px] text-foreground" title={r.title}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Takes a new picture of what is live (wakes a sleeping app). Done when a newer picture arrives;
 * when the control plane gives up it says why, and the old picture stays.
 */
function RetakeButton({ app }: { app: AppDetail }) {
  const queryClient = useQueryClient()
  // What was there when asked: the button waits for either to change.
  const [asked, setAsked] = useState<{ shot: string | null; failure: string | null } | null>(null)
  const shot = app.preview?.capturedAt ?? null
  const failure = app.previewAttempt?.failed ?? null
  const busy = asked !== null
  useEffect(() => {
    if (!asked) return
    if (shot !== asked.shot) {
      setAsked(null)
      toast.success('New picture taken')
      return
    }
    if (failure && failure.at !== asked.failure) {
      setAsked(null)
      toast.error('Could not take a new picture', { description: `${capitalize(failure.reason)}. The old one stays.` })
      return
    }
    const poll = window.setInterval(
      () => queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(APPS_SCOPE, app.id, app.environment) }),
      3000,
    )
    // The control plane gives up after 90 s and says so; this is only a backstop.
    const stop = window.setTimeout(() => setAsked(null), 120_000)
    return () => {
      window.clearInterval(poll)
      window.clearTimeout(stop)
    }
  }, [asked, shot, failure, app.id, app.environment, queryClient])
  const retake = async () => {
    try {
      await appsClient.post(`/apps/${encodeURIComponent(app.id)}/preview`, undefined, {
        params: { env: app.environment },
      })
      setAsked({ shot, failure: failure?.at ?? null })
    } catch (error) {
      handleApiError(error, 'Could not take a new picture')
    }
  }
  return (
    <button
      type="button"
      onClick={() => void retake()}
      disabled={busy}
      title={busy ? 'Taking a new picture (up to a minute when the app is asleep)…' : 'Take a new picture'}
      aria-label="Take a new picture"
      className="text-muted-foreground transition-colors hover:text-foreground disabled:cursor-wait"
    >
      <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
    </button>
  )
}
