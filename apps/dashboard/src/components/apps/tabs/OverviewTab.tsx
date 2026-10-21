/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ChevronRight } from '@/components/ui/icon'
import { appStatusOf, relTime, STATUS } from '@/lib/apps/format'
import type { AppDetail, AppProblem, AppRelease, AppService, AppTab } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { toast } from 'sonner'
import { AgentHandoffPanel } from '../AgentHandoffPanel'
import { HandoffToAgent } from '../HandoffToAgent'
import {
  CopyIconButton,
  copyText,
  Disclosure,
  FlatButton,
  GridHeader,
  HoverActions,
  PromptBlock,
  SectionTitle,
  SpecRow,
  StatusBadge,
} from '../spec'
import { ToolButton } from '../SubNav'
import { MetricStrip } from '../viz'

// Overview answers three things, in this order: does anything need you, what
// is live right now, and how it is doing. Identity (app id, image, created) is
// one click away under Details; process ids and exit codes live inside each
// service row. One primary action per state: open the app when healthy, copy
// the fix when broken, hand the app to the agent when nothing is deployed.

const sum = (data: number[]) => data.reduce((a, b) => a + b, 0)
const last = (data: number[]) => data[data.length - 1] ?? 0
const SERVICE_GRID = 'grid-cols-[minmax(0,1.4fr)_140px_minmax(0,1fr)_110px] gap-x-4'

function copyWithNotice(text: string, notice: string) {
  copyText(text)
  toast.success(notice)
}

/** Something real is broken: say what once, and put the repair first. */
function FailurePanel({
  app,
  failing,
  previous,
  onRollback,
  onOpenLogs,
}: {
  app: AppDetail
  failing: AppProblem[]
  previous: AppRelease | null
  onRollback: (release: AppRelease) => void
  onOpenLogs: () => void
}) {
  const prompt = failing
    .map((problem) => problem.fixPrompt)
    .filter(Boolean)
    .join('\n\n')
  return (
    <section className="border border-destructive/40 bg-destructive/[0.04] px-5 py-4">
      {failing.map((check) => {
        return (
          <div key={check.summary} className="flex flex-col gap-1 font-mono">
            <StatusBadge label={check.summary} color={STATUS.error} className="text-body font-semibold" />
            <span className="pl-[15px] text-[13px] text-muted-foreground">{check.detail}</span>
          </div>
        )
      })}
      <div className="mt-4 flex flex-wrap items-center gap-1 pl-[15px]">
        {prompt && (
          <FlatButton
            variant="primary"
            onClick={() => copyWithNotice(prompt, `Copied fix instructions for ${app.name} · ${app.environment}`)}
          >
            Copy fix instructions
          </FlatButton>
        )}
        <FlatButton onClick={onOpenLogs}>View logs</FlatButton>
        {previous && <FlatButton onClick={() => onRollback(previous)}>Roll back to {previous.id}</FlatButton>}
      </div>
      {prompt && (
        <div className="mt-3 pl-[15px]">
          <Disclosure label="Show instructions">
            <PromptBlock text={prompt} compact />
          </Disclosure>
        </div>
      )}
    </section>
  )
}

/** A new environment is not a broken one: nothing red, one task, one action. */

/** What is live: the address, the deployment and what it changed. */
function LiveDeployment({
  app,
  active,
  onGoTo,
}: {
  app: AppDetail
  active: AppRelease | null
  onGoTo: (tab: AppTab, section?: string) => void
}) {
  const runtime = appStatusOf(app.status)
  return (
    <section className="grid gap-x-10 gap-y-6">
      <div className="flex min-w-0 flex-col gap-5 py-1">
        <div className="flex flex-col gap-2">
          <span className="inline-flex max-w-full items-center gap-2">
            <a
              href={app.openUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate font-mono text-em font-semibold text-foreground hover:underline"
            >
              {app.url.replace(/^https?:\/\//, '')}
            </a>
            <CopyIconButton text={app.url} />
          </span>
          {/* The header already states the runtime; only a quiet state (asleep, deploying) gets a line of why. */}
          {app.status !== 'live' && app.statusDetail && (
            <StatusBadge label={app.statusDetail} color={runtime.color} className="font-normal" />
          )}
        </div>

        {active && (
          <div className="flex flex-col gap-1 font-mono">
            <button
              type="button"
              onClick={() => onGoTo('deployments')}
              className="flex min-w-0 items-baseline gap-2 text-left text-body hover:underline"
            >
              <span className="font-semibold text-foreground">{active.id}</span>
              <span className="truncate text-foreground">{active.summary}</span>
            </button>
            <span className="text-[12px] text-muted-foreground">
              {relTime(active.createdAt)} by {active.by}
              {app.box ? ` · box ${app.box.id}` : ''}
            </span>
          </div>
        )}

        <Disclosure label="Details">
          <div className="max-w-[560px]">
            <SpecRow label="App">
              <span className="inline-flex items-center gap-2">
                {app.name} <CopyIconButton text={app.name} title="Copy app name" />
              </span>
            </SpecRow>
            {app.runtime && (
              <SpecRow label="Runtime">
                {app.runtime.image} · {app.runtime.size}
                {app.runtime.cpus !== null && app.runtime.memoryMib !== null
                  ? ` (${app.runtime.cpus} CPU, ${app.runtime.memoryMib / 1024} GB)`
                  : ''}
              </SpecRow>
            )}
            {app.box && (
              <SpecRow label="Box">
                {app.box.id} · {app.box.state}
              </SpecRow>
            )}
            {app.specVersion !== null && <SpecRow label="Configuration">version {app.specVersion}</SpecRow>}
            <SpecRow label="Created">
              <span title={new Date(app.createdAt).toLocaleString()}>{relTime(app.createdAt)}</span>
            </SpecRow>
          </div>
        </Disclosure>
      </div>
    </section>
  )
}

function serviceState(service: AppService): { label: string; color: string } {
  switch (service.state) {
    case 'running':
      return { label: 'Running', color: STATUS.running }
    case 'failed':
      return { label: 'Crashed', color: STATUS.error }
    case 'stopped':
      return { label: 'Stopped', color: STATUS.stopped }
    default:
      return { label: service.state.charAt(0).toUpperCase() + service.state.slice(1), color: STATUS.idle }
  }
}

function healthText(service: AppService): { text: string; bad: boolean } {
  if (service.health === 'healthy') return { text: 'Healthy', bad: false }
  if (service.health === 'unhealthy') return { text: 'Failing health check', bad: true }
  if (service.health === 'starting') return { text: 'Starting', bad: false }
  return { text: 'No health check', bad: false }
}

function ServiceRow({
  service,
  restarting,
  onRestart,
}: {
  service: AppService
  restarting: boolean
  onRestart: () => void
}) {
  const [open, setOpen] = useState(false)
  const state = restarting ? { label: 'Restarting…', color: STATUS.idle } : serviceState(service)
  const health = healthText(service)
  return (
    <div className="border-b border-border/60">
      <div
        className={`group grid ${SERVICE_GRID} min-h-[48px] cursor-pointer items-center px-2 font-mono text-body transition-colors hover:bg-card/50`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
          />
          <span className="font-semibold text-foreground">{service.name}</span>
          {service.port && <span className="text-muted-foreground">:{service.port}</span>}
          {service.exposed && <span className="text-[11px] text-muted-foreground">serves the URL</span>}
        </span>
        <StatusBadge label={state.label} color={state.color} caps />
        <span className={cn('truncate', health.bad ? 'text-destructive' : 'text-muted-foreground')}>{health.text}</span>
        <span onClick={(e) => e.stopPropagation()}>
          <HoverActions>
            <ToolButton onClick={onRestart} loading={restarting}>
              Restart
            </ToolButton>
          </HoverActions>
        </span>
      </div>
      {open && (
        <div className="max-w-[640px] px-3 pb-3 pl-9">
          <SpecRow label={service.staticDir ? 'Serves' : 'Command'}>{service.command.join(' ') || '—'}</SpecRow>
          <SpecRow label="Process">
            pid {service.pid ?? '—'} · {service.restarts} restart{service.restarts === 1 ? '' : 's'}
          </SpecRow>
          {service.healthPath && <SpecRow label="Health path">{service.healthPath}</SpecRow>}
          {service.lastExitCode !== undefined && <SpecRow label="Last exit">code {service.lastExitCode}</SpecRow>}
        </div>
      )}
    </div>
  )
}

export function OverviewTab({
  app,
  onGoTo,
  onRollback,
  onRestartService,
  restarting,
}: {
  app: AppDetail
  onGoTo: (tab: AppTab, section?: string) => void
  onRollback: (release: AppRelease) => void
  onRestartService: (service: string) => void
  /** The service being restarted right now, if any. */
  restarting: string | null
}) {
  const active = app.releases.find((r) => r.id === app.activeRelease) ?? null
  // The newest earlier deployment that can still go live again.
  const previous = app.releases.find((r) => !r.current && r.rollback.possible) ?? null
  const failing = app.problems
  const m = app.metrics
  const total = m ? sum(m.requests) : 0
  const delta =
    m?.previousRequests && m.previousRequests > 0
      ? Math.round(((total - m.previousRequests) / m.previousRequests) * 100)
      : null
  const errTotal = m ? sum(m.errors) : 0
  const errRate = total ? (errTotal / total) * 100 : 0

  if (app.status === 'draft') {
    return <HandoffToAgent app={app} />
  }

  return (
    <div className="flex flex-col gap-10">
      {failing.length > 0 && (
        <FailurePanel
          app={app}
          failing={failing}
          previous={previous}
          onRollback={onRollback}
          onOpenLogs={() => onGoTo('logs', 'runtime')}
        />
      )}

      <LiveDeployment app={app} active={active} onGoTo={onGoTo} />

      <section>
        <SectionTitle
          title="Services"
          right={
            app.services.length > 1 && (
              <ToolButton onClick={() => app.services.forEach((s) => onRestartService(s.name))}>Restart all</ToolButton>
            )
          }
        />
        {app.services.length === 0 ? (
          <p className="font-mono text-[13px] text-muted-foreground">
            Nothing declared. A [[service]] in boxlite.toml names the command, port and health path; the next deployment
            starts it.
          </p>
        ) : (
          <div>
            <GridHeader grid={SERVICE_GRID} columns={['Service', 'State', 'Health', '']} />
            {app.services.map((service) => (
              <ServiceRow
                key={service.name}
                service={service}
                restarting={restarting === service.name}
                onRestart={() => onRestartService(service.name)}
              />
            ))}
          </div>
        )}
      </section>

      {/* From the app proxy's access log; hidden until the URL has had traffic. */}
      {m && (
        <section>
          <SectionTitle title="Last 24 hours" />
          <MetricStrip
            metrics={[
              {
                label: 'Requests',
                value: total.toLocaleString('en-US'),
                caption: delta === null ? undefined : `${delta >= 0 ? '+' : ''}${delta}% vs previous 24h`,
                data: m.requests,
              },
              {
                label: 'Errors (5xx)',
                value: errTotal.toLocaleString('en-US'),
                caption: `${errRate.toFixed(2)}% of requests`,
                tone: errRate > 1 ? 'bad' : 'neutral',
                data: m.errors,
              },
              {
                label: 'p95 latency',
                value: String(last(m.p95Ms)),
                unit: 'ms',
                caption: 'this hour, to first byte',
                tone: last(m.p95Ms) > 500 ? 'bad' : 'neutral',
                data: m.p95Ms,
              },
            ]}
          />
        </section>
      )}

      <AgentHandoffPanel app={app} />
    </div>
  )
}
