/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { downloadUrl } from '@/lib/apps/client'
import { actorName, releaseStatusOf, relTime } from '@/lib/apps/format'
import { RELEASE_IN_PROGRESS, type AppDetail, type AppRelease } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { DeploymentDetail } from '../DeploymentDetail'
import { EmptyNote, GridHeader, HoverActions, MoreButton, SearchField, StatusBadge } from '../spec'
import { FilterChip, FilterGroup, Screen, ToolButton, Workbench } from '../SubNav'
import { ServicesSection } from './ServicesSection'
import { useElapsed } from '../useElapsed'
import { Tag } from '../viz'

// Each row is one deployment as the control plane ran it: what changed (the agent's message, or
// the control plane's diff), its status, who, when. A rollback is itself a deployment. A row opens
// the deployment's full timeline (?deployment=N), which deep links to its logs.

const ROW_GRID = 'grid-cols-[120px_64px_minmax(0,1fr)_150px_80px_140px] gap-x-4'

function Progress({ release }: { release: AppRelease }) {
  const elapsed = useElapsed(release.running?.since ?? release.startedAt ?? release.createdAt)
  return (
    <span className="truncate text-[12px] text-muted-foreground">
      {release.running
        ? `${release.running.name}${release.running.detail ? ` · ${release.running.detail}` : ''}`
        : 'queued'}
      {elapsed ? ` · ${elapsed}` : ''}
    </span>
  )
}

function DeploymentRow({
  app,
  release,
  rollingBack,
  onRollback,
  onSelect,
  onOpenLogs,
}: {
  app: AppDetail
  release: AppRelease
  rollingBack: boolean
  onRollback: (release: AppRelease) => void
  onSelect: () => void
  onOpenLogs: () => void
}) {
  const status = releaseStatusOf(release.status)
  const inProgress = RELEASE_IN_PROGRESS.includes(release.status)
  const source = `/apps/${encodeURIComponent(app.id)}/deployments/${release.number}/source?env=${encodeURIComponent(app.environment)}`
  return (
    <div
      role="link"
      tabIndex={0}
      aria-label={`Deployment ${release.id}`}
      data-testid={`deployment-row-${release.number}`}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onSelect()}
      className={cn(
        `group grid ${ROW_GRID} min-h-[52px] cursor-pointer items-center border-b border-border/60 px-2 py-2 font-mono text-body outline-none transition-colors hover:bg-card/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/35`,
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
        {release.status === 'failed' && (release.cause || release.error) && (
          <span className="truncate text-[12px] text-destructive" title={release.error}>
            {release.cause ?? release.error}
          </span>
        )}
        {inProgress && <Progress release={release} />}
      </span>
      <span className="truncate text-muted-foreground" title={release.by}>
        {actorName(release.by, { short: true })}
      </span>
      <span className="text-muted-foreground" title={new Date(release.createdAt).toLocaleString('en-US')}>
        {relTime(release.createdAt)}
      </span>
      <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="flex justify-end">
        <HoverActions>
          {release.rollback.possible && !rollingBack && (
            <ToolButton onClick={() => onRollback(release)}>Roll back</ToolButton>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <MoreButton aria-label={`Actions for ${release.id}`} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[14rem] font-mono">
              <DropdownMenuItem className="cursor-pointer" onClick={onSelect}>
                Timeline and log
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer" onClick={onOpenLogs}>
                View in Logs
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
  )
}

type Section = 'history' | 'services'

/** Deployments: the history (and one deployment's timeline), and the services they run. */
export function DeploymentsTab({
  app,
  section,
  onSection,
  onRollback,
  rollingBack = null,
  selected,
  onSelect,
  onOpenLogs,
  restarting,
  onRestartService,
}: {
  app: AppDetail
  /** ?section=services, else the history. */
  section?: string
  onSection: (next: Section) => void
  onRollback: (release: AppRelease) => void
  rollingBack?: string | null
  /** The deployment whose timeline is open (?deployment=N). */
  selected: number | null
  onSelect: (n: number | null) => void
  onOpenLogs: (n: number) => void
  restarting: string | null
  onRestartService: (service: string) => void
}) {
  if (selected) {
    return (
      <DeploymentDetail
        app={app}
        number={selected}
        onBack={() => onSelect(null)}
        onRollback={onRollback}
        onOpenLogs={onOpenLogs}
      />
    )
  }
  const current: Section = section === 'services' ? 'services' : 'history'
  return (
    <Workbench<Section>
      items={[
        { id: 'history', label: 'Deployments', count: app.releases.length },
        { id: 'services', label: 'Services', count: app.services.length },
      ]}
      value={current}
      onChange={onSection}
    >
      {current === 'services' ? (
        <ServicesSection app={app} restarting={restarting} onRestartService={onRestartService} />
      ) : (
        <History
          app={app}
          onRollback={onRollback}
          rollingBack={rollingBack}
          onSelect={onSelect}
          onOpenLogs={onOpenLogs}
        />
      )}
    </Workbench>
  )
}

function History({
  app,
  onRollback,
  rollingBack,
  onSelect,
  onOpenLogs,
}: {
  app: AppDetail
  onRollback: (release: AppRelease) => void
  rollingBack: string | null
  onSelect: (n: number | null) => void
  onOpenLogs: (n: number) => void
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
    <Screen title="Deployments" padded={false}>
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
          {app.releases.length === 0 &&
            'Your agent deploys from its project folder. Each deployment lands here with its steps, changes and log, live while it runs.'}
        </EmptyNote>
      ) : (
        <>
          <GridHeader grid={ROW_GRID} columns={['Status', '', 'What changed', 'By', 'When', '']} />
          {rows.map((release) => (
            <DeploymentRow
              key={release.id}
              app={app}
              release={release}
              rollingBack={rollingBack === release.id}
              onRollback={onRollback}
              onSelect={() => onSelect(release.number)}
              onOpenLogs={() => onOpenLogs(release.number)}
            />
          ))}
        </>
      )}
    </Screen>
  )
}
