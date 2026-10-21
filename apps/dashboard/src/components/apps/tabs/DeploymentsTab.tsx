/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { formatBytes, relTime, STATUS } from '@/lib/apps/format'
import type { AppDetail, AppRelease } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyNote, GridHeader, HoverActions, MoreButton, SearchField, SpecRow, StatusBadge } from '../spec'
import { Spinner } from '@/components/ui/spinner'
import { FilterChip, FilterGroup, Screen, ToolButton } from '../SubNav'
import { Tag } from '../viz'

// Each row is a readable record: what changed (the agent's one-line summary),
// whether it built, who, when. "Current" is a separate marker from success:
// a deployment can have succeeded and no longer be the one serving. Build
// numbers (files, size, time) and the log open with the row.

const ROW_GRID = 'grid-cols-[110px_64px_minmax(0,1fr)_120px_80px_140px] gap-x-4'

function resultOf(release: AppRelease): { label: string; color: string } {
  return release.status === 'failed'
    ? { label: 'Failed', color: STATUS.error }
    : { label: 'Ready', color: STATUS.running }
}

export function DeploymentRow({
  release,
  onRollback,
  onRevertVariables,
  rollingBack = false,
}: {
  release: AppRelease
  onRollback: (release: AppRelease) => void
  onRevertVariables?: (release: AppRelease) => void
  /** This deployment is going live again right now. */
  rollingBack?: boolean
}) {
  const [open, setOpen] = useState(false)
  const result = resultOf(release)
  return (
    <div className="border-b border-border/60">
      <div
        onClick={() => setOpen((v) => !v)}
        className={`group grid ${ROW_GRID} min-h-[52px] cursor-pointer items-center px-2 py-2 font-mono text-body transition-colors hover:bg-card/50`}
      >
        <StatusBadge label={result.label} color={result.color} caps />
        <span className="font-semibold text-foreground">{release.id}</span>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-3">
            <span className="truncate text-foreground">{release.summary ?? 'Deployment'}</span>
            {release.status === 'active' && <Tag tone="brand">Current</Tag>}
            {rollingBack && (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-warning">
                <Spinner className="size-3" /> Going live…
              </span>
            )}
          </span>
          {release.status === 'failed' && release.error && (
            <span className="truncate text-[12px] text-destructive">{release.error}</span>
          )}
        </span>
        <span className="truncate text-muted-foreground">{release.by}</span>
        <span className="text-muted-foreground">{relTime(release.createdAt)}</span>
        <span onClick={(e) => e.stopPropagation()} className="flex justify-end">
          <HoverActions>
            {release.status === 'previous' && !rollingBack && (
              <ToolButton onClick={() => onRollback(release)}>Roll back</ToolButton>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <MoreButton aria-label="Deployment actions" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[14rem] font-mono">
                <DropdownMenuItem className="cursor-pointer" onClick={() => setOpen(true)}>
                  View build log
                </DropdownMenuItem>
                {release.status === 'previous' && (
                  <DropdownMenuItem className="cursor-pointer" onClick={() => onRollback(release)}>
                    Roll back to {release.id}
                  </DropdownMenuItem>
                )}
                {release.envChanges?.length && onRevertVariables ? (
                  <DropdownMenuItem className="cursor-pointer" onClick={() => onRevertVariables(release)}>
                    Revert its variable changes
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={() => {
                    const url = URL.createObjectURL(new Blob([release.log.join('\n')], { type: 'application/gzip' }))
                    const link = document.createElement('a')
                    link.href = url
                    link.download = `${release.id.replace('#', 'deployment-')}.tar.gz`
                    link.click()
                    URL.revokeObjectURL(url)
                    toast.success(`Downloading the source of ${release.id}`)
                  }}
                >
                  Download source
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </HoverActions>
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-3 px-3 pb-4 pl-[138px]">
          <div className="max-w-[560px]">
            <SpecRow label="Upload">
              {release.files} files · {formatBytes(release.bytes)}
            </SpecRow>
            <SpecRow label="Build time">
              {release.prepareSeconds !== undefined ? `${release.prepareSeconds} s` : '—'}
            </SpecRow>
          </div>
          <pre className="bg-card/60 px-4 py-3 font-mono text-[12px] leading-[1.75] text-muted-foreground">
            {release.log.map((line, i) => (
              <div
                key={i}
                className={cn(
                  /fail|ERR|exited 1|refused/.test(line) && 'text-destructive',
                  line.startsWith('>') && 'text-foreground',
                )}
              >
                {line}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}

export function DeploymentsTab({
  app,
  onRollback,
  rollingBack = null,
  building = null,
  onRevertVariables,
}: {
  app: AppDetail
  onRollback: (release: AppRelease) => void
  onRevertVariables?: (release: AppRelease) => void
  rollingBack?: string | null
  /** A deployment still being created; it heads the list until it lands. */
  building?: { id: string; stage: string; summary: string } | null
}) {
  const [filter, setFilter] = useState<'all' | 'ready' | 'failed'>('all')
  const [search, setSearch] = useState('')
  const rows = app.releases.filter((release) => {
    if (filter === 'ready' && release.status === 'failed') return false
    if (filter === 'failed' && release.status !== 'failed') return false
    const haystack = `${release.id} ${release.summary ?? ''} ${release.by} ${release.error ?? ''}`.toLowerCase()
    return !search || haystack.includes(search.toLowerCase())
  })
  return (
    <Screen title={`Deployments to ${app.environment}`} padded={false}>
      <div className="flex flex-wrap items-center gap-3 pb-3">
        <SearchField value={search} onChange={setSearch} placeholder="Filter deployments…" />
        <FilterGroup>
          {(['all', 'ready', 'failed'] as const).map((candidate) => (
            <FilterChip key={candidate} selected={filter === candidate} onClick={() => setFilter(candidate)}>
              {candidate.charAt(0).toUpperCase() + candidate.slice(1)}
            </FilterChip>
          ))}
        </FilterGroup>
      </div>
      {rows.length === 0 ? (
        <EmptyNote title={app.releases.length === 0 ? 'No deployments yet' : 'Nothing matches'}>
          {app.releases.length === 0 && (
            <>Your agent runs boxlite deploy ./ --app {app.name}. Each deployment lands here with its build log.</>
          )}
        </EmptyNote>
      ) : (
        <>
          <GridHeader grid={ROW_GRID} columns={['Result', '', 'What changed', 'By', 'When', '']} />
          {building && (
            <div
              className={`grid ${ROW_GRID} relative min-h-[52px] items-center bg-warning/[0.04] px-2 py-2 font-mono text-body border-b border-border/60`}
            >
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.5px] text-warning">
                <Spinner className="size-[11px]" /> Deploying
              </span>
              <span className="font-semibold text-foreground">{building.id}</span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-foreground">{building.summary}</span>
                <span className="truncate text-[12px] text-muted-foreground">{building.stage}…</span>
              </span>
              <span className="truncate text-muted-foreground">markov</span>
              <span className="text-muted-foreground">now</span>
              <span />
            </div>
          )}
          {rows.map((release) => (
            <DeploymentRow
              key={release.id}
              release={release}
              onRollback={onRollback}
              onRevertVariables={onRevertVariables}
              rollingBack={rollingBack === release.id}
            />
          ))}
        </>
      )}
    </Screen>
  )
}
