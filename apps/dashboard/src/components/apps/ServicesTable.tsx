/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { STATUS } from '@/lib/apps/format'
import type { AppService } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { GridHeader, HoverActions, StatusBadge } from './spec'
import { ToolButton } from './SubNav'

// Every service of the environment as the supervisor reports it: state, health, restarts, last
// exit code, pid and port, with its command underneath. A crashing or unhealthy service shows its
// last error lines in place, so the cause is read without leaving the page.

const GRID = 'grid-cols-[minmax(0,1.6fr)_120px_minmax(0,1fr)_80px_80px_170px_96px] gap-x-4'

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
  if (service.state === 'asleep') return { text: 'wakes on the next request', bad: false }
  if (service.health === 'healthy')
    return { text: `Healthy${service.healthPath ? ` · ${service.healthPath}` : ''}`, bad: false }
  if (service.health === 'unhealthy') return { text: `Failing ${service.healthPath ?? 'health check'}`, bad: true }
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
  const state = stateOf(service, restarting, started)
  const health = healthOf(service)
  const exitBad = service.lastExitCode !== undefined && service.lastExitCode !== 0
  return (
    <div className="border-b border-border/60" data-testid={`service-${service.name}`}>
      <div className={`grid ${GRID} min-h-[56px] items-center px-2 py-2 font-mono text-body`}>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-semibold text-foreground">{service.name}</span>
            {service.exposed && <span className="text-[11px] text-muted-foreground">serves the URL</span>}
          </span>
          <span className="truncate text-[12px] text-muted-foreground" title={service.command.join(' ')}>
            {service.command.join(' ') || '—'}
          </span>
        </span>
        <StatusBadge label={state.label} color={state.color} caps />
        <span className={cn('truncate', health.bad ? 'text-destructive' : 'text-muted-foreground')}>{health.text}</span>
        <span className={cn('tabular-nums', service.restarts > 0 ? 'text-warning' : 'text-muted-foreground')}>
          {service.restarts}
        </span>
        <span className={cn('tabular-nums', exitBad ? 'text-destructive' : 'text-muted-foreground')}>
          {service.lastExitCode ?? '—'}
        </span>
        <span className="truncate tabular-nums text-muted-foreground">
          {service.pid ? `pid ${service.pid}` : '—'}
          {service.port ? ` · :${service.port}` : ''}
        </span>
        <HoverActions>
          {service.state !== 'asleep' && started && (
            <ToolButton onClick={onRestart} loading={restarting}>
              Restart
            </ToolButton>
          )}
        </HoverActions>
      </div>
      {service.recentErrors.length > 0 && (
        <pre className="mx-2 mb-3 max-h-[180px] overflow-auto bg-destructive/[0.05] px-3 py-2 font-mono text-[12px] leading-[1.6] text-destructive">
          {service.recentErrors.join('\n')}
        </pre>
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
    <div className="overflow-x-auto">
      <div className="min-w-[860px]">
        <GridHeader grid={GRID} columns={['Service', 'State', 'Health', 'Restarts', 'Last exit', 'Process', '']} />
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
    </div>
  )
}
