/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BRAND } from '@/components/ascii'
import { X } from '@/components/ui/icon'
import { relTime } from '@/lib/apps/format'
import type { AppDetail, AppLogSource } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useEffect, useMemo, useRef, useState } from 'react'
import { CopyIconButton, EmptyNote, Panel, SearchField } from '../spec'
import { FilterChip, FilterGroup, Screen, ToolButton, Workbench } from '../SubNav'

const SOURCES: AppLogSource[] = ['web', 'worker', 'deploy', 'auth', 'db', 'system']
const STREAM_SAMPLES: { source: AppLogSource; message: string }[] = [
  { source: 'web', message: 'GET /api/deals 200 38ms user=a.lin@acme.com' },
  { source: 'web', message: 'GET /api/contacts?page=2 200 61ms user=c.wu@acme.com' },
  { source: 'web', message: 'POST /api/deals/318/move 200 44ms user=b.ortiz@acme.com' },
  { source: 'worker', message: 'sync: 3 deals updated' },
  { source: 'auth', message: 'login ok provider=google email=d.kaur@acme.com' },
  { source: 'web', message: 'GET /healthz 200 2ms' },
]
const RANGES = ['30m', '1h', '24h', '3d'] as const
const RANGE_MS: Record<(typeof RANGES)[number], number> = {
  '30m': 30 * 60_000,
  '1h': 3_600_000,
  '24h': 86_400_000,
  '3d': 3 * 86_400_000,
}
const ROW_GRID = 'grid-cols-[76px_64px_minmax(0,1fr)] gap-x-4'
const ACTIVITY_GRID = 'grid-cols-[100px_130px_110px_minmax(0,1fr)] gap-x-3'

type Level = 'info' | 'warn' | 'error'
type Section = 'runtime' | 'activity'

interface Line {
  id: string
  at: Date
  source: AppLogSource
  level: Level
  message: string
  raw: string
}

function dayLabel(at: Date): string {
  const today = new Date()
  const yesterday = new Date(today.getTime() - 86_400_000)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const date = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return same(at, today) ? `today · ${date}` : same(at, yesterday) ? `yesterday · ${date}` : date
}

function levelOf(message: string): Level {
  if (/fail|exit 1|exited 1|mismatch|refused|error|giving up/i.test(message)) return 'error'
  if (/warn|restart|retry|stopped|SIGTERM/i.test(message)) return 'warn'
  return 'info'
}

function RuntimeLogs({ app, source }: { app: AppDetail; source?: string }) {
  // No source picked means every source; picking narrows to the picked ones.
  const [sources, setSources] = useState<Set<AppLogSource>>(() =>
    SOURCES.includes(source as AppLogSource) ? new Set([source as AppLogSource]) : new Set(),
  )
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all')
  const [search, setSearch] = useState('')
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h')
  const [live, setLive] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

  const lines = useMemo<Line[]>(() => {
    const all: Line[] = []
    for (const source of SOURCES) {
      for (const [i, raw] of (app.logs[source] ?? []).entries()) {
        const [stamp, ...rest] = raw.split(' ')
        all.push({
          id: `${source}-${i}`,
          at: new Date(stamp),
          source,
          level: levelOf(raw),
          message: rest.join(' '),
          raw,
        })
      }
    }
    return all.sort((a, b) => b.at.getTime() - a.at.getTime())
  }, [app.logs])

  // A running app keeps talking: while Live is on, new lines arrive at the top. When the
  // reader has paused, scrolled away or opened a line, they wait behind a "new lines" chip
  // instead of moving what is being read.
  const [streamed, setStreamed] = useState<Line[]>([])
  const [held, setHeld] = useState<Line[]>([])
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const following = useRef(live)
  following.current = live && selected === null
  useEffect(() => {
    if (app.status !== 'live') return
    const timer = window.setInterval(() => {
      const sample = STREAM_SAMPLES[Math.floor(Math.random() * STREAM_SAMPLES.length)]
      const at = new Date()
      const line: Line = {
        id: `live-${at.getTime()}`,
        at,
        source: sample.source,
        level: levelOf(sample.message),
        message: sample.message,
        raw: `${at.toISOString()} ${sample.message}`,
      }
      if (!following.current || window.scrollY > 160) {
        setHeld((h) => [line, ...h])
      } else {
        setStreamed((list) => [line, ...list].slice(0, 200))
        setFresh((f) => new Set(f).add(line.id))
        window.setTimeout(
          () =>
            setFresh((f) => {
              const next = new Set(f)
              next.delete(line.id)
              return next
            }),
          1600,
        )
      }
    }, 2800)
    return () => window.clearInterval(timer)
  }, [app.status])
  const showHeld = () => {
    setLive(true)
    setSelected(null)
    setStreamed((list) => [...held, ...list].slice(0, 200))
    setHeld([])
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const allLines = useMemo(() => [...streamed, ...lines], [streamed, lines])

  const since = Date.now() - RANGE_MS[range]
  const visible = allLines.filter((line) => {
    if (line.at.getTime() < since) return false
    if (sources.size > 0 && !sources.has(line.source)) return false
    if (level === 'error' && line.level !== 'error') return false
    if (level === 'warn' && line.level === 'info') return false
    if (search && !line.message.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const detail = visible.find((line) => line.id === selected) ?? null

  const toggleSource = (source: AppLogSource) =>
    setSources((prev) => {
      const next = new Set(prev)
      if (next.has(source)) next.delete(source)
      else next.add(source)
      return next
    })

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
        <SearchField value={search} onChange={setSearch} placeholder="Search messages…" className="w-[260px]" />
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
        <FilterGroup className="ml-auto">
          {SOURCES.map((source) => {
            const count = allLines.filter((line) => line.source === source && line.at.getTime() >= since).length
            if (count === 0 && !sources.has(source)) return null
            return (
              <FilterChip key={source} selected={sources.has(source)} onClick={() => toggleSource(source)}>
                {source} <span className="ml-1 text-muted-foreground">{count}</span>
              </FilterChip>
            )
          })}
        </FilterGroup>
      </div>

      {held.length > 0 && (
        <div className="sticky top-2 z-10 flex justify-center">
          <button
            type="button"
            onClick={showHeld}
            className="mt-2 bg-foreground px-3 py-1.5 font-mono text-[13px] font-semibold text-background shadow-lg"
          >
            {held.length} new line{held.length === 1 ? '' : 's'} · Show
          </button>
        </div>
      )}
      <div className={cn('grid', detail && 'lg:grid-cols-[minmax(0,1fr)_320px]')}>
        <div className="min-w-0">
          {visible.length === 0 ? (
            <EmptyNote title="No log lines match" />
          ) : (
            <>
              {visible.map((line, i) => {
                // Newest first; a day rule wherever the date changes, so a 24h window
                // that crosses midnight never reads as one unbroken sequence.
                const day = dayLabel(line.at)
                const newDay = i === 0 || dayLabel(visible[i - 1].at) !== day
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
                        {line.at.toLocaleTimeString([], { hour12: false })}
                      </span>
                      <span className="text-muted-foreground">{line.source}</span>
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
            </>
          )}
        </div>
        {detail && (
          <Panel className="self-start border-l border-border/60">
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
                ['Deployment', app.activeRelease ?? '—'],
                ['Environment', app.environment],
                ['Box', app.workspace.boxName],
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

function Activity({ app }: { app: AppDetail }) {
  return (
    <Screen title="Activity · who changed what" padded={false}>
      {app.activity.map((entry) => (
        <div
          key={entry.id}
          className={`grid ${ACTIVITY_GRID} min-h-[44px] items-center px-2 border-b border-border/60`}
        >
          <span className="text-muted-foreground">{relTime(entry.at)}</span>
          <span className="truncate text-foreground">{entry.actor}</span>
          <span className="text-foreground">{entry.action}</span>
          <span className="truncate text-muted-foreground">{entry.detail}</span>
        </div>
      ))}
    </Screen>
  )
}

export function LogsTab({
  app,
  section,
  source,
  onSection,
}: {
  app: AppDetail
  section?: string
  source?: string
  onSection: (next: Section) => void
}) {
  const current: Section = section === 'activity' ? 'activity' : 'runtime'
  return (
    <Workbench<Section>
      feature="logs"
      items={[
        { id: 'runtime', label: 'Runtime logs' },
        { id: 'activity', label: 'Activity', count: app.activity.length },
      ]}
      value={current}
      onChange={onSection}
    >
      {current === 'runtime' ? <RuntimeLogs app={app} source={source} /> : <Activity app={app} />}
    </Workbench>
  )
}
