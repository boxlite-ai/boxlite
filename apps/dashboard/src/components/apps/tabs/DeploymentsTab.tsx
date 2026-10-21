/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { useReleaseLog } from '@/hooks/queries/useAppsQuery'
import { downloadUrl } from '@/lib/apps/client'
import { formatBytes, releaseStatusOf, relTime } from '@/lib/apps/format'
import { RELEASE_IN_PROGRESS, type AppDetail, type AppRelease } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { EmptyNote, GridHeader, HoverActions, MoreButton, SearchField, SpecRow, StatusBadge } from '../spec'
import { FilterChip, FilterGroup, Screen, ToolButton } from '../SubNav'
import { Tag } from '../viz'

// Each row is a readable record of one deployment as the control plane ran it:
// what changed (the agent's message, or the control plane's diff), its status,
// who, when. "Current" is a separate marker from the status word. A rollback is
// itself a new deployment. Steps, the change list and the log open with the row.

const ROW_GRID = 'grid-cols-[120px_64px_minmax(0,1fr)_150px_80px_140px] gap-x-4'

function stepLine(step: AppRelease['steps'][number]): string {
  const ms = step.ms !== undefined ? ` · ${(step.ms / 1000).toFixed(1)} s` : ''
  return `${step.name} ${step.status}${ms}${step.detail ? ` · ${step.detail}` : ''}`
}

function DeploymentLog({ appId, release }: { appId: string; release: AppRelease }) {
  const inProgress = RELEASE_IN_PROGRESS.includes(release.status)
  const { data, isLoading } = useReleaseLog(appId, release.number, true, inProgress)
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Spinner className="size-3.5" /> Loading the log…
      </div>
    )
  }
  const lines = data?.log ?? []
  return (
    <pre className="max-h-[420px] overflow-auto bg-card/60 px-4 py-3 font-mono text-[12px] leading-[1.75] text-muted-foreground">
      {lines.length === 0 ? (
        <div>No log lines for this deployment.</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className={cn(/\[(build|system)\].*(fail|error|ERR|exited)/i.test(line) && 'text-destructive')}>
            {line}
          </div>
        ))
      )}
    </pre>
  )
}

export function DeploymentRow({
  app,
  release,
  onRollback,
  rollingBack = false,
}: {
  app: AppDetail
  release: AppRelease
  onRollback: (release: AppRelease) => void
  /** A rollback to this deployment is being started right now. */
  rollingBack?: boolean
}) {
  const [open, setOpen] = useState(false)
  const status = releaseStatusOf(release.status)
  const inProgress = RELEASE_IN_PROGRESS.includes(release.status)
  const running = release.steps.find((s) => s.status === 'running')
  const source = `/apps/${encodeURIComponent(app.id)}/deployments/${release.number}/source?env=${encodeURIComponent(app.environment)}`
  return (
    <div className="border-b border-border/60">
      <div
        onClick={() => setOpen((v) => !v)}
        className={cn(
          `group grid ${ROW_GRID} min-h-[52px] cursor-pointer items-center px-2 py-2 font-mono text-body transition-colors hover:bg-card/50`,
          inProgress && 'bg-warning/[0.04]',
        )}
      >
        {inProgress ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.5px] text-warning">
            <Spinner className="size-[11px]" /> {status.label}
          </span>
        ) : (
          <StatusBadge label={status.label} color={status.color} caps />
        )}
        <span className="font-semibold text-foreground">{release.id}</span>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-foreground">{release.summary}</span>
            {release.current && <Tag tone="brand">Current</Tag>}
            {rollingBack && (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-warning">
                <Spinner className="size-3" /> Starting rollback…
              </span>
            )}
          </span>
          {release.status === 'failed' && release.error && (
            <span className="truncate text-[12px] text-destructive">{release.error}</span>
          )}
          {inProgress && running && (
            <span className="truncate text-[12px] text-muted-foreground">
              {running.name}
              {running.detail ? ` · ${running.detail}` : ''}…
            </span>
          )}
        </span>
        <span className="truncate text-muted-foreground">{release.by}</span>
        <span className="text-muted-foreground">{relTime(release.createdAt)}</span>
        <span onClick={(e) => e.stopPropagation()} className="flex justify-end">
          <HoverActions>
            {release.rollback.possible && !rollingBack && (
              <ToolButton onClick={() => onRollback(release)}>Roll back</ToolButton>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <MoreButton aria-label="Deployment actions" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[14rem] font-mono">
                <DropdownMenuItem className="cursor-pointer" onClick={() => setOpen(true)}>
                  View steps and log
                </DropdownMenuItem>
                {release.rollback.possible && (
                  <DropdownMenuItem className="cursor-pointer" onClick={() => onRollback(release)}>
                    Roll back to {release.id}
                  </DropdownMenuItem>
                )}
                {release.hasSource && (
                  <DropdownMenuItem asChild className="cursor-pointer">
                    <a href={downloadUrl(source)} download>
                      Download source
                    </a>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </HoverActions>
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-4 pl-[154px]">
          <div className="max-w-[720px]">
            {release.files !== null && release.bytes !== null && (
              <SpecRow label="Upload">
                {release.files} files · {formatBytes(release.bytes)}
              </SpecRow>
            )}
            {release.buildSeconds !== null && <SpecRow label="Build time">{release.buildSeconds} s</SpecRow>}
            {release.restorePoint && (
              <SpecRow label="Restore point">{new Date(release.restorePoint).toLocaleString()}</SpecRow>
            )}
            {!release.current && !release.rollback.possible && release.rollback.reason && (
              <SpecRow label="Rollback">{release.rollback.reason}</SpecRow>
            )}
            {release.steps.length > 0 && (
              <SpecRow label="Steps">
                <span className="flex flex-col">
                  {release.steps.map((step, i) => (
                    <span key={i} className={cn(step.status === 'failed' && 'text-destructive')}>
                      {stepLine(step)}
                    </span>
                  ))}
                </span>
              </SpecRow>
            )}
            {release.changes.length > 0 && (
              <SpecRow label="Changes">
                <span className="flex flex-col">
                  {release.changes.map((change, i) => (
                    <span key={i}>{change}</span>
                  ))}
                </span>
              </SpecRow>
            )}
          </div>
          <DeploymentLog appId={app.id} release={release} />
        </div>
      )}
    </div>
  )
}

export function DeploymentsTab({
  app,
  onRollback,
  rollingBack = null,
}: {
  app: AppDetail
  onRollback: (release: AppRelease) => void
  rollingBack?: string | null
}) {
  const [filter, setFilter] = useState<'all' | 'live' | 'failed'>('all')
  const [search, setSearch] = useState('')
  const rows = app.releases.filter((release) => {
    if (filter === 'live' && release.status !== 'live') return false
    if (filter === 'failed' && release.status !== 'failed') return false
    const haystack = `${release.id} ${release.summary} ${release.by} ${release.error ?? ''}`.toLowerCase()
    return !search || haystack.includes(search.toLowerCase())
  })
  return (
    <Screen title={`Deployments to ${app.environment}`} padded={false}>
      <div className="flex flex-wrap items-center gap-3 pb-3">
        <SearchField value={search} onChange={setSearch} placeholder="Filter deployments…" />
        <FilterGroup>
          {(['all', 'live', 'failed'] as const).map((candidate) => (
            <FilterChip key={candidate} selected={filter === candidate} onClick={() => setFilter(candidate)}>
              {candidate.charAt(0).toUpperCase() + candidate.slice(1)}
            </FilterChip>
          ))}
        </FilterGroup>
      </div>
      {rows.length === 0 ? (
        <EmptyNote title={app.releases.length === 0 ? 'No deployments yet' : 'Nothing matches'}>
          {app.releases.length === 0 && (
            <>Your agent runs boxlite-app deploy. Each deployment lands here with its steps and log.</>
          )}
        </EmptyNote>
      ) : (
        <>
          <GridHeader grid={ROW_GRID} columns={['Status', '', 'What changed', 'By', 'When', '']} />
          {rows.map((release) => (
            <DeploymentRow
              key={release.id}
              app={app}
              release={release}
              onRollback={onRollback}
              rollingBack={rollingBack === release.id}
            />
          ))}
        </>
      )}
    </Screen>
  )
}
