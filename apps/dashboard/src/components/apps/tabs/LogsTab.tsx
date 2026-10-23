/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BRAND } from '@/components/ascii'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Check, ChevronDown, X } from '@/components/ui/icon'
import { Spinner } from '@/components/ui/spinner'
import { useAppLogs } from '@/hooks/queries/useAppsQuery'
import { errorText } from '@/lib/apps/client'
import { relTime } from '@/lib/apps/format'
import type { ActivityLink, AppActivity, AppDetail, AppLogLine, AppTab } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CopyIconButton, EmptyNote, Panel, SearchField } from '../spec'
import { FilterChip, FilterGroup, Screen, ToolButton, Workbench } from '../SubNav'

// The control plane curates the stream (console-logs.ts): deployment milestones arrive as `deploy`,
// migrations as `db`, and platform chatter, build output and visitor requests are marked `detail`.
// The default view leaves detail lines out; they show only when their source is picked.
const CURATED_SOURCES = ['deploy', 'db', 'auth', 'schedule']
const DETAIL_SOURCES = ['build', 'access', 'system']
const PAGE = 200
const RANGES = ['30m', '1h', '24h', '3d'] as const
const RANGE_MS: Record<(typeof RANGES)[number], number> = {
  '30m': 30 * 60_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
  '3d': 3 * 86_400_000,
}
const ROW_GRID = 'grid-cols-[76px_64px_minmax(0,1fr)] gap-x-4'
const ACTIVITY_GRID = 'grid-cols-[100px_130px_200px_minmax(0,1fr)_110px] gap-x-3'
/** How far the reader may scroll before new lines stop arriving at the top. */
const FOLLOW_SCROLL = 160

type Level = 'info' | 'warn' | 'error'
type Section = 'runtime' | 'activity'

interface Line {
  id: string
  at: Date
  source: string
  level: Level
  message: string
  raw: string
  deployment: number | null
  detail: boolean
}

function dayLabel(at: Date): string {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const date = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return same(at, today) ? `today · ${date}` : same(at, yesterday) ? `yesterday · ${date}` : date
}

/** The platform's own sources (build output, visitor requests, platform chatter), picked from a menu. */
function PlatformSources({
  counts,
  selected,
  onToggle,
}: {
  counts: Record<string, number>
  selected: Set<string>
  onToggle: (source: string) => void
}) {
  const picked = DETAIL_SOURCES.filter((source) => selected.has(source))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Build output, visitor requests and platform detail"
          className={cn(
            '-ml-px inline-flex h-[30px] items-center gap-1 border border-border px-3 font-mono text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/35',
            picked.length
              ? 'relative z-10 border-foreground/45 bg-background font-semibold text-foreground'
              : 'text-muted-foreground hover:text-foreground data-[state=open]:text-foreground',
          )}
        >
          {picked.length ? picked.join(', ') : 'Platform'}
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem] font-mono">
        {DETAIL_SOURCES.map((source) => (
          <DropdownMenuItem
            key={source}
            className="cursor-pointer justify-between gap-4"
            onSelect={(e) => {
              e.preventDefault()
              onToggle(source)
            }}
          >
            <span className="flex items-center gap-2">
              <Check className={cn('size-3.5', selected.has(source) ? 'opacity-100' : 'opacity-0')} />
              {source}
            </span>
            <span className="text-muted-foreground">{counts[source] ?? 0}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RuntimeLogs({
  app,
  source,
  deployment,
  onDeployment,
  onOpenDeployment,
}: {
  app: AppDetail
  source?: string
  deployment: number | null
  onDeployment: (n: number | null) => void
  onOpenDeployment: (n: number) => void
}) {
  // No source picked means the curated stream; picking narrows to the picked sources, detail included.
  const [sources, setSources] = useState<Set<string>>(() => (source ? new Set([source]) : new Set()))
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all')
  const [search, setSearch] = useState('')
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h')
  const [live, setLive] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [scrolledAway, setScrolledAway] = useState(false)
  // The newest PAGE lines render; older ones come in a page at a time, so a busy 24h window
  // stays one screen of reading instead of thousands of rows.
  const [limit, setLimit] = useState(PAGE)
  useEffect(() => setLimit(PAGE), [sources, level, search, range])
  useEffect(() => {
    const onScroll = () => setScrolledAway(window.scrollY > FOLLOW_SCROLL)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // The control plane is polled all along. While the reader follows, new lines arrive at the top;
  // once they pause, open a line or scroll away, the page holds still and new lines wait behind
  // "N new lines · Show".
  const following = live && selected === null && !scrolledAway
  const { data: fetched = [], isLoading, error } = useAppLogs(app.id, range, true, deployment)
  const allLines = useMemo<Line[]>(
    () =>
      (fetched as (AppLogLine & { detail?: boolean })[]).map((l) => ({
        id: l.id,
        at: new Date(l.ts),
        source: l.source,
        level: l.level,
        message: l.line,
        raw: `${l.ts} [${l.source}] ${l.line}`,
        deployment: l.deployment,
        detail: !!l.detail,
      })),
    [fetched],
  )
  // Newest line the reader has seen; anything later waits while they are not following.
  const [heldAfter, setHeldAfter] = useState<number | null>(null)
  const newest = allLines[0]?.at.getTime() ?? 0
  useEffect(() => {
    if (following) setHeldAfter(null)
    else setHeldAfter((held) => held ?? newest)
    // Only a change of following moves the cut-off; new lines must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following])
  const shown = heldAfter === null ? allLines : allLines.filter((l) => l.at.getTime() <= heldAfter)
  const held = heldAfter === null ? 0 : allLines.length - shown.length
  const showHeld = () => {
    setLive(true)
    setSelected(null)
    setHeldAfter(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Mark lines that arrived since the last poll, briefly.
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (isLoading) return
    const ids = new Set(allLines.map((l) => l.id))
    if (seen.current && heldAfter === null) {
      const added = allLines.filter((l) => !seen.current?.has(l.id)).map((l) => l.id)
      if (added.length) {
        setFresh(new Set(added))
        const timer = window.setTimeout(() => setFresh(new Set()), 1600)
        seen.current = ids
        return () => window.clearTimeout(timer)
      }
    }
    seen.current = ids
  }, [allLines, isLoading, heldAfter])

  const since = Date.now() - RANGE_MS[range]
  const inRange = shown.filter((line) => line.at.getTime() >= since)
  const counts: Record<string, number> = {}
  for (const line of inRange) counts[line.source] = (counts[line.source] ?? 0) + 1
  // The app's services, then the platform's curated sources, then anything else that logged.
  const curatedList = [
    ...new Set([
      ...app.services.map((s) => s.name),
      ...CURATED_SOURCES,
      ...inRange.map((l) => l.source).filter((s) => !DETAIL_SOURCES.includes(s)),
    ]),
  ]
  const visible = inRange.filter((line) => {
    if (sources.size > 0 ? !sources.has(line.source) : line.detail) return false
    if (level === 'error' && line.level !== 'error') return false
    if (level === 'warn' && line.level === 'info') return false
    if (search && !line.message.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const rows = visible.slice(0, limit)
  const detail = visible.find((line) => line.id === selected) ?? null

  const toggleSource = (source: string) =>
    setSources((prev) => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })
  const pickedNames = [...sources].join(', ')

  return (
    <Screen
      title="Runtime logs"
      actions={
        <ToolButton
          onClick={() => (live ? setLive(false) : showHeld())}
          title={live ? 'Stop new lines from moving the page' : 'Show held lines and keep following'}
        >
          <span
            className="size-[6px] rounded-full"
            style={{
              background: live ? BRAND : 'hsl(var(--muted-foreground))',
              animation: live ? 'live-pulse 1.6s infinite' : undefined,
            }}
          />
          {live ? 'Live' : 'Paused'}
          <span className="text-muted-foreground">· {live ? 'Pause' : 'Resume'}</span>
        </ToolButton>
      }
      padded={false}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 pb-3">
        <SearchField value={search} onChange={setSearch} placeholder="Search messages…" className="w-[220px]" />
        <FilterGroup>
          {(['all', 'warn', 'error'] as const).map((candidate) => (
            <FilterChip key={candidate} selected={level === candidate} onClick={() => setLevel(candidate)}>
              {candidate === 'all' ? 'All' : candidate === 'warn' ? 'Warnings' : 'Errors'}
            </FilterChip>
          ))}
        </FilterGroup>
        <FilterGroup>
          {RANGES.map((candidate) => (
            <FilterChip key={candidate} selected={range === candidate} onClick={() => setRange(candidate)}>
              {candidate}
            </FilterChip>
          ))}
        </FilterGroup>
        {deployment !== null && (
          <FilterGroup>
            <FilterChip selected onClick={() => onDeployment(null)} title="Show every deployment">
              Deployment #{deployment} <X className="size-3.5" />
            </FilterChip>
          </FilterGroup>
        )}
        <FilterGroup className="ml-auto">
          {curatedList.map((name) => {
            const count = counts[name] ?? 0
            if (count === 0 && !sources.has(name)) return null
            return (
              <FilterChip key={name} selected={sources.has(name)} onClick={() => toggleSource(name)}>
                {name} <span className="ml-1 text-muted-foreground">{count}</span>
              </FilterChip>
            )
          })}
          <PlatformSources counts={counts} selected={sources} onToggle={toggleSource} />
        </FilterGroup>
      </div>

      {held > 0 && (
        <div className="sticky top-2 z-10 flex justify-center">
          <button
            type="button"
            onClick={showHeld}
            className="mt-2 bg-foreground px-3 py-1.5 font-mono text-[13px] font-semibold text-background shadow-lg"
          >
            {held} new line{held === 1 ? '' : 's'} · Show
          </button>
        </div>
      )}
      <div className={cn('grid', detail && 'lg:grid-cols-[minmax(0,1fr)_320px]')}>
        <div className="min-w-0">
          {error ? (
            <EmptyNote title="The logs could not be read">{errorText(error)}</EmptyNote>
          ) : isLoading ? (
            <div className="flex items-center gap-2 py-8 text-[13px] text-muted-foreground">
              <Spinner className="size-4" /> Loading logs…
            </div>
          ) : visible.length === 0 ? (
            <EmptyNote
              title={
                search || level !== 'all'
                  ? 'No log lines match'
                  : `No ${pickedNames ? `${pickedNames} ` : ''}lines${deployment ? ` from #${deployment}` : ''} in the last ${range}`
              }
            >
              {!app.activeRelease && 'Logs start with the first deployment.'}
            </EmptyNote>
          ) : (
            <>
              {rows.map((line, i) => {
                // Newest first; a day rule wherever the date changes, so a 24h window
                // that crosses midnight never reads as one unbroken sequence.
                const day = dayLabel(line.at)
                const newDay = i === 0 || dayLabel(rows[i - 1].at) !== day
                return (
                  <div key={line.id}>
                    {newDay && (
                      <div className="sticky top-0 z-[1] bg-background pb-1 pt-3 text-[12px] font-medium text-muted-foreground">
                        {day.charAt(0).toUpperCase() + day.slice(1)}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelected(selected === line.id ? null : line.id)}
                      className={cn(
                        `grid ${ROW_GRID} w-full items-center px-2 py-[5px] text-left text-[12px] transition-colors hover:bg-card/60`,
                        selected === line.id && 'bg-card',
                        fresh.has(line.id) ? 'bg-brand/10 transition-none' : 'transition-colors duration-700',
                      )}
                    >
                      <span className="tabular-nums text-muted-foreground">
                        {line.at.toLocaleTimeString('en-US', { hour12: false })}
                      </span>
                      <span className="truncate text-muted-foreground">{line.source}</span>
                      <span
                        className={cn(
                          'truncate',
                          line.level === 'error'
                            ? 'text-destructive'
                            : line.level === 'warn'
                              ? 'text-warning'
                              : 'text-foreground',
                        )}
                      >
                        {line.message}
                      </span>
                    </button>
                  </div>
                )
              })}
              {visible.length > rows.length && (
                <div className="flex items-center justify-center gap-3 py-4 text-[12px] text-muted-foreground">
                  Showing the newest {rows.length} of {visible.length} lines
                  <ToolButton onClick={() => setLimit((n) => n + PAGE)}>Show older</ToolButton>
                </div>
              )}
            </>
          )}
        </div>
        {detail && (
          <Panel className="sticky top-2 self-start border-l border-border/60">
            <div className="flex items-center justify-between px-4 py-2 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">Log line</span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close"
                className="p-1 transition-colors hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex flex-col gap-3 px-4 pb-3">
              {[
                ['Time', detail.at.toISOString()],
                ['Source', detail.source],
                ['Level', detail.level],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-2">
                  <span className="w-[96px] shrink-0 text-muted-foreground">{label}</span>
                  <span className="min-w-0 break-all text-foreground">{value}</span>
                </div>
              ))}
              <div className="flex items-baseline gap-2">
                <span className="w-[96px] shrink-0 text-muted-foreground">Deployment</span>
                {detail.deployment !== null ? (
                  <button
                    type="button"
                    className="text-foreground underline-offset-2 hover:underline"
                    onClick={() => detail.deployment !== null && onOpenDeployment(detail.deployment)}
                  >
                    #{detail.deployment} →
                  </button>
                ) : (
                  <span className="text-foreground">—</span>
                )}
              </div>
              {[
                ['Environment', app.environment],
                ['Box', app.box?.id ?? '—'],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline gap-2">
                  <span className="w-[96px] shrink-0 text-muted-foreground">{label}</span>
                  <span className="min-w-0 break-all text-foreground">{value}</span>
                </div>
              ))}
              <div className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-muted-foreground">
                  Message <CopyIconButton text={detail.raw} />
                </span>
                <pre className="whitespace-pre-wrap break-words bg-card/60 p-3 text-[12px] leading-[1.6] text-foreground">
                  {detail.message}
                </pre>
              </div>
            </div>
          </Panel>
        )}
      </div>
    </Screen>
  )
}

const ACTOR_TONE: Record<string, string> = {
  agent: 'text-foreground',
  console: 'text-foreground',
  admin: 'text-warning',
  system: 'text-muted-foreground',
}

function linkLabel(link: ActivityLink): string {
  if (link.deployment) return `#${link.deployment} →`
  return `${link.tab.charAt(0).toUpperCase() + link.tab.slice(1)} →`
}

/** Who changed what: reads (an agent checking status or context) change nothing, so they are left out. */
const changes = (activity: AppActivity[]) => activity.filter((entry) => !/^read\b/.test(entry.action))

function Activity({ app, onGoTo }: { app: AppDetail; onGoTo: (link: ActivityLink) => void }) {
  const entries = changes(app.activity)
  return (
    <Screen title="Activity · who changed what" padded={false}>
      {entries.length === 0 ? (
        <EmptyNote title="Nothing has happened yet">
          Every change by your agent, this console or an admin is listed here.
        </EmptyNote>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.id}
            data-testid="activity-row"
            className={`grid ${ACTIVITY_GRID} min-h-[44px] items-center border-b border-border/60 px-2`}
          >
            <span className="text-muted-foreground" title={new Date(entry.at).toLocaleString('en-US')}>
              {relTime(entry.at)}
            </span>
            <span className={cn('truncate', ACTOR_TONE[entry.actorKind])} title={entry.actorKind}>
              {entry.actor}
            </span>
            <span className="text-foreground">{entry.action}</span>
            <span className="truncate text-muted-foreground">{entry.detail}</span>
            <span className="text-right">
              {entry.link && (
                <button
                  type="button"
                  onClick={() => entry.link && onGoTo(entry.link)}
                  className="text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/35"
                >
                  {linkLabel(entry.link)}
                </button>
              )}
            </span>
          </div>
        ))
      )}
    </Screen>
  )
}

export function LogsTab({
  app,
  section,
  source,
  deployment,
  onSection,
  onDeployment,
  onOpenDeployment,
  onGoTo,
}: {
  app: AppDetail
  section?: string
  source?: string
  /** Only lines of this deployment (?deployment=N). */
  deployment: number | null
  onSection: (next: Section) => void
  onDeployment: (n: number | null) => void
  onOpenDeployment: (n: number) => void
  onGoTo: (tab: AppTab, section?: string, extra?: Record<string, string>) => void
}) {
  const current: Section = section === 'activity' ? 'activity' : 'runtime'
  return (
    <Workbench<Section>
      feature="logs"
      items={[
        { id: 'runtime', label: 'Runtime logs' },
        { id: 'activity', label: 'Activity', count: changes(app.activity).length },
      ]}
      value={current}
      onChange={onSection}
    >
      {current === 'runtime' ? (
        <RuntimeLogs
          app={app}
          source={source}
          deployment={deployment}
          onDeployment={onDeployment}
          onOpenDeployment={onOpenDeployment}
        />
      ) : (
        <Activity
          app={app}
          onGoTo={(link) =>
            onGoTo(link.tab, link.section, link.deployment ? { deployment: String(link.deployment) } : undefined)
          }
        />
      )}
    </Workbench>
  )
}
