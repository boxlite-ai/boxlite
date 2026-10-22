/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArrowUpRight } from '@/components/ui/icon'
import { downloadUrl } from '@/lib/apps/client'
import { actorName, capitalize, relTime, STATUS, VISIBILITY_LABEL } from '@/lib/apps/format'
import { openApp } from '@/lib/apps/open'
import type { AppDetail, AppRelease, AppTab } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'
import { DeployProgress } from './DeployProgress'
import { CopyIconButton } from './spec'

// The top of the Overview: what is live (the app as visitors see it, in a browser frame with its
// address, and the deployment that put it there) and what the agent built behind it, drawn the
// way boxlite.ai draws infrastructure: visitors reach an address, the address a Box running the
// app's services, the Box its database, files and sign-in. Each part shows its state and opens
// its tab. Every fact appears once; the header already says the app's state.

const PROVIDER_NAME: Record<string, string> = { github: 'GitHub', google: 'Google' }

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
    <section className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,520px)_minmax(0,1fr)]">
      <figure className="min-w-0 border border-border bg-card">
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

      <div className="flex min-w-0 flex-col justify-center gap-4">
        <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-foreground">
          <span className={failing ? 'text-destructive' : 'text-brand'}>▸</span>{' '}
          {failing ? 'Live · not healthy' : asleep ? 'Live · asleep until the next visit' : 'Live now'}
        </span>
        {active ? (
          <>
            <button
              type="button"
              onClick={() => onGoTo('deployments', undefined, { deployment: String(active.number) })}
              className="text-left font-display text-[24px] font-semibold leading-tight tracking-[-0.5px] text-foreground hover:underline"
            >
              {active.summary}
            </button>
            <span className="font-mono text-[13px] text-muted-foreground">
              {active.id} · deployed{' '}
              <span title={new Date(active.createdAt).toLocaleString()}>{relTime(active.createdAt)}</span> by{' '}
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
      </div>
    </section>
  )
}

type Tone = 'good' | 'idle' | 'bad' | 'off'
const DOT: Record<Tone, string> = { good: STATUS.running, idle: STATUS.idle, bad: STATUS.error, off: STATUS.stopped }

function Node({
  label,
  title,
  detail,
  tone,
  icon,
  onClick,
  children,
}: {
  label: string
  title: string
  detail?: string
  tone: Tone
  icon?: ReactNode
  onClick?: () => void
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-w-0 flex-col gap-2 border border-border bg-card px-4 py-3 text-left transition-colors hover:border-brand/70"
    >
      <span className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
        {label}
        <span className="size-[6px]" style={{ background: DOT[tone] }} />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="min-w-0 truncate font-display text-[15px] font-semibold text-foreground">{title}</span>
      </span>
      {detail && <span className="truncate font-mono text-[11px] text-muted-foreground">{detail}</span>}
      {children}
    </button>
  )
}

/** A dashed connector with an arrowhead, as on boxlite.ai's diagrams. */
const Link = () => (
  <span aria-hidden="true" className="hidden items-center md:flex">
    <span className="h-px flex-1 border-t border-dashed border-brand/50" />
    <span className="-ml-[3px] text-[10px] leading-none text-brand/70">▶</span>
  </span>
)

/** What the agent built: visitors → address → Box → database, files, sign-in, schedules. */
export function StackDiagram({ app, onGoTo }: { app: AppDetail; onGoTo: (tab: AppTab, section?: string) => void }) {
  const asleep = app.status === 'sleeping'
  const up = app.services.filter((s) => s.state === 'running' && s.health !== 'unhealthy').length
  const all = app.services.length
  const boxTone: Tone = asleep ? 'off' : all === 0 ? 'off' : up === all ? 'good' : 'idle'
  const backing: ReactNode[] = []
  if (app.database)
    backing.push(
      <Node
        key="db"
        label="Database"
        title={app.database.engine}
        detail={`as DATABASE_URL in ${app.database.injectedInto.join(', ') || 'no service yet'}`}
        tone={asleep ? 'off' : 'good'}
        onClick={() => onGoTo('database')}
      />,
    )
  if (app.storages.length)
    backing.push(
      <Node
        key="files"
        label="Files"
        title={app.storages.map((v) => v.name).join(', ')}
        detail={app.storages.map((v) => v.mountPath).join(', ')}
        tone={asleep ? 'off' : 'good'}
        onClick={() => onGoTo('volumes')}
      />,
    )
  if (app.auth.declared)
    backing.push(
      <Node
        key="auth"
        label="Sign-in"
        title={app.auth.providers.map((p) => PROVIDER_NAME[p] ?? p).join(' · ') || 'Sign-in'}
        detail={`${app.auth.users} user${app.auth.users === 1 ? '' : 's'}`}
        tone={app.auth.enforced ? 'good' : 'idle'}
        onClick={() => onGoTo('auth')}
      />,
    )
  if (app.schedules.length)
    backing.push(
      <Node
        key="jobs"
        label="Schedules"
        title={`${app.schedules.length} job${app.schedules.length === 1 ? '' : 's'}`}
        detail={app.schedules.map((s) => s.name).join(', ')}
        tone={asleep ? 'off' : 'good'}
        onClick={() => onGoTo('deployments', 'services')}
      />,
    )

  return (
    <section className="flex flex-col gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-foreground">
        <span className="text-brand">▸</span> What your agent built
      </span>
      <div className="relative border border-border bg-[linear-gradient(hsl(var(--border)/0.35)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--border)/0.35)_1px,transparent_1px)] bg-[size:40px_40px] p-5">
        <div
          className={cn(
            'grid items-center gap-3',
            backing.length > 0
              ? 'md:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_28px_minmax(0,1.25fr)_28px_minmax(0,1.15fr)]'
              : 'md:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_28px_minmax(0,1.25fr)]',
          )}
        >
          <Node
            label="Visitors"
            title={app.visibility === 'public' ? 'Anyone' : capitalize(VISIBILITY_LABEL[app.visibility])}
            detail={app.visibility === 'public' ? 'no sign-in to open it' : 'others see a private page'}
            tone="good"
            onClick={() => onGoTo('domains')}
          />
          <Link />
          <Node
            label="Address"
            title={app.name}
            detail={host(app.url)}
            tone={app.activeRelease ? 'good' : 'off'}
            onClick={() => onGoTo('domains')}
          />
          <Link />
          <Node
            label="Box"
            title={app.runtime ? `${app.runtime.image} · ${app.runtime.size}` : 'Box'}
            icon={<IsoCube size={16} tone={boxTone === 'good' ? 'brand' : 'muted'} />}
            tone={boxTone}
            onClick={() => onGoTo('deployments', 'services')}
          >
            <span className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
              {asleep ? (
                <span>asleep · wakes on the next visit</span>
              ) : all === 0 ? (
                <span>no services yet</span>
              ) : (
                app.services.map((s) => (
                  <span key={s.name} className="inline-flex items-center gap-1.5">
                    <span
                      className="size-[5px]"
                      style={{
                        background:
                          s.state === 'running' && s.health !== 'unhealthy'
                            ? STATUS.running
                            : s.state === 'failed' || s.health === 'unhealthy'
                              ? STATUS.error
                              : STATUS.idle,
                      }}
                    />
                    {s.name}
                  </span>
                ))
              )}
            </span>
          </Node>
          {backing.length > 0 && <Link />}
          {backing.length > 0 && <div className="flex min-w-0 flex-col gap-3">{backing}</div>}
        </div>
      </div>
    </section>
  )
}
