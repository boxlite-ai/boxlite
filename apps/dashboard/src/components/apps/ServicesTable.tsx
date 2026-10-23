/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ChevronRight } from '@/components/ui/icon'
import { STATUS } from '@/lib/apps/format'
import type { AppService } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { GridHeader, HoverActions, SpecRow, StatusBadge } from './spec'
import { ToolButton } from './SubNav'

// Every service of the environment as the supervisor reports it, one compact row each: name,
// state, health, Restart. The process details (command, pid, port, restarts, last exit, health
// path) open with the row; a crashing or unhealthy service opens by itself and shows its last
// error lines, so the cause is read without leaving the page.

const GRID = 'grid-cols-[minmax(0,1.4fr)_140px_minmax(0,1fr)_110px] gap-x-4'

/** `started`: a release has gone live, so a stopped service is really stopped (not waiting for its first start). */
function stateOf(service: AppService, restarting: boolean, started: boolean): { label: string; color: string } {
  if (restarting) return { label: 'Restarting…', color: STATUS.idle }
  switch (service.state) {
    case 'running':
      return { label: 'Running', color: STATUS.running }
    case 'failed':
      return { label: 'Crashed', color: STATUS.error }
    case 'stopped':
      return { label: started ? 'Stopped' : 'Not started', color: STATUS.stopped }
    case 'asleep':
      return { label: 'Asleep', color: STATUS.stopped }
    default:
      return { label: service.state.charAt(0).toUpperCase() + service.state.slice(1), color: STATUS.idle }
  }
}

function healthOf(service: AppService): { text: string; bad: boolean } {
  if (service.state === 'asleep') return { text: 'Wakes on the next request', bad: false }
  if (service.health === 'healthy') return { text: 'Healthy', bad: false }
  if (service.health === 'unhealthy') return { text: 'Failing health check', bad: true }
  if (service.health === 'starting') return { text: 'Starting', bad: false }
  return { text: service.staticDir ? 'Static files' : 'No health check', bad: false }
}

function ServiceRow({
  service,
  restarting,
  started,
  onRestart,
}: {
  service: AppService
  restarting: boolean
  started: boolean
  onRestart: () => void
}) {
  const troubled = service.recentErrors.length > 0
  const [open, setOpen] = useState(troubled)
  const state = stateOf(service, restarting, started)
  const health = healthOf(service)
  const process = [
    service.pid ? `pid ${service.pid}` : null,
    service.port ? `port ${service.port}` : null,
    `${service.restarts} restart${service.restarts === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="border-b border-border/60" data-testid={`service-${service.name}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && setOpen((v) => !v)}
        className={`group grid ${GRID} min-h-[48px] cursor-pointer items-center px-2 font-mono text-body outline-none transition-colors hover:bg-card/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/35`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          <span className="font-semibold text-foreground">{service.name}</span>
        </span>
        <StatusBadge label={state.label} color={state.color} caps />
        <span className={cn('truncate', health.bad ? 'text-destructive' : 'text-muted-foreground')}>{health.text}</span>
        <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <HoverActions>
            {service.state !== 'asleep' && started && (
              <ToolButton onClick={onRestart} loading={restarting}>
                Restart
              </ToolButton>
            )}
          </HoverActions>
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3 pl-9">
          <div className="max-w-[640px]">
            <SpecRow label="Command">{service.command.join(' ') || '—'}</SpecRow>
            <SpecRow label="Process">{process}</SpecRow>
            {service.exposed && <SpecRow label="Serves">the app&apos;s URL</SpecRow>}
            {service.healthPath && <SpecRow label="Health path">{service.healthPath}</SpecRow>}
            {service.lastExitCode !== undefined && (
              <SpecRow label="Last exit">{exitMeaning(service.lastExitCode)}</SpecRow>
            )}
          </div>
          {troubled && (
            <pre className="max-h-[180px] overflow-auto bg-destructive/[0.05] px-3 py-2 font-mono text-[12px] leading-[1.6] text-destructive">
              {service.recentErrors.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

export function ServicesTable({
  services,
  started,
  restarting,
  onRestart,
}: {
  services: AppService[]
  started: boolean
  restarting: string | null
  onRestart: (service: string) => void
}) {
  return (
    <div>
      <GridHeader grid={GRID} columns={['Service', 'State', 'Health', '']} />
      {services.map((service) => (
        <ServiceRow
          key={service.name}
          service={service}
          restarting={restarting === service.name}
          started={started}
          onRestart={() => onRestart(service.name)}
        />
      ))}
    </div>
  )
}

/** An exit code in words: 143 and 130 are the stop signal of a restart or a deploy, not a crash; 137 is a kill (often memory). */
function exitMeaning(code: number | null): string {
  if (code === null) return '—'
  if (code === 0) return 'code 0 (it ended normally)'
  if (code === 143 || code === 130) return `code ${code} (stopped by a restart or deploy)`
  if (code === 137) return 'code 137 (killed, often for running out of memory)'
  return `code ${code} (it crashed)`
}
