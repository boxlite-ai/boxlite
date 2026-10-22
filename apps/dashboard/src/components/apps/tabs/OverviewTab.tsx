/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { downloadUrl } from '@/lib/apps/client'
import { actorName, appStatusOf, relTime, STATUS } from '@/lib/apps/format'
import { openApp } from '@/lib/apps/open'
import type { AppDetail, AppProblem, AppRelease, AppTab } from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { AgentHandoffPanel } from '../AgentHandoffPanel'
import { DeployProgress } from '../DeployProgress'
import { HandoffToAgent } from '../HandoffToAgent'
import { SchedulesTable } from '../SchedulesTable'
import { ServicesTable } from '../ServicesTable'
import {
  CopyIconButton,
  copyText,
  Disclosure,
  FlatButton,
  PromptBlock,
  SectionTitle,
  SpecRow,
  StatusBadge,
} from '../spec'
import { ToolButton } from '../SubNav'
import { LivePreview, MetricStrip } from '../viz'

// Overview answers three things, in this order: does anything need you, what
// is live right now, and how it is doing. Identity (app id, image, created) is
// one click away under Details; process ids and exit codes live inside each
// service row. One primary action per state: open the app when healthy, copy
// the fix when broken, hand the app to the agent when nothing is deployed.

const sum = (data: number[]) => data.reduce((a, b) => a + b, 0)
const last = (data: number[]) => data[data.length - 1] ?? 0
/** The newest hour that had requests, or null: an hour without requests has no latency. */
const lastMeasured = (data: (number | null)[]) => [...data].reverse().find((v) => v !== null) ?? null

function copyWithNotice(text: string, notice: string) {
  copyText(text)
  toast.success(notice)
}

/** Something real is broken: say what once, with the classified cause, and put the repair first. */
function FailurePanel({
  app,
  failing,
  previous,
  onRollback,
  onOpenLogs,
  onOpenDeployment,
  onSetVariable,
}: {
  app: AppDetail
  failing: AppProblem[]
  previous: AppRelease | null
  onRollback: (release: AppRelease) => void
  onOpenLogs: () => void
  onOpenDeployment: (n: number) => void
  onSetVariable: (name: string) => void
}) {
  const prompt = failing
    .map((problem) => problem.fixPrompt)
    .filter(Boolean)
    .join('\n\n')
  const failedDeployment = failing.find((p) => p.deployment)?.deployment
  // A failed deployment with an older release still serving needs a fix, not a rollback.
  const serving = failing.find((p) => p.serving)?.serving
  // A service that says which variable it lacks can be fixed here, without the agent.
  const missing = failing.find((p) => p.missingVariable)?.missingVariable
  return (
    <section className="border border-destructive/40 bg-destructive/[0.04] px-5 py-4" data-testid="failure-panel">
      {failing.map((check) => (
        <div key={check.summary} className="flex flex-col gap-1 font-mono">
          <StatusBadge label={check.summary} color={STATUS.error} className="text-body font-semibold" />
          <span className="pl-[15px] text-[13px] text-muted-foreground">{check.detail}</span>
          {check.serving && (
            <span className="pl-[15px] text-[12px] text-muted-foreground">{check.serving} keeps serving users.</span>
          )}
        </div>
      ))}
      <div className="mt-4 flex flex-wrap items-center gap-1 pl-[15px]">
        {missing && (
          <FlatButton variant="primary" onClick={() => onSetVariable(missing)}>
            Set {missing}
          </FlatButton>
        )}
        {prompt && (
          <FlatButton
            variant={missing ? undefined : 'primary'}
            onClick={() => copyWithNotice(prompt, `Copied fix instructions for ${app.name} · ${app.environment}`)}
          >
            Copy fix instructions
          </FlatButton>
        )}
        {failedDeployment ? (
          <FlatButton onClick={() => onOpenDeployment(failedDeployment)}>View #{failedDeployment}</FlatButton>
        ) : (
          <FlatButton onClick={onOpenLogs}>View logs</FlatButton>
        )}
        {previous && !serving && (
          <FlatButton onClick={() => onRollback(previous)}>Roll back to {previous.id}</FlatButton>
        )}
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

/** What is live: the picture, the address, the deployment and what it changed. */
function LiveDeployment({
  app,
  active,
  failing,
  onGoTo,
}: {
  app: AppDetail
  active: AppRelease | null
  failing: boolean
  onGoTo: (tab: AppTab, section?: string) => void
}) {
  const runtime = appStatusOf(app.status)
  const open = () => void openApp(app.id, app.environment)
  // A failing app gets no screenshot: the last good picture would say all is well.
  const preview = app.preview && !failing ? { ...app.preview, src: downloadUrl(app.preview.src) } : null
  return (
    <section className={cn('grid gap-x-10 gap-y-6', preview && 'lg:grid-cols-[340px_minmax(0,1fr)]')}>
      {preview && <LivePreview preview={preview} liveRelease={app.activeRelease} onOpen={open} name={app.name} />}
      <div className="flex min-w-0 flex-col gap-5 py-1">
        <div className="flex flex-col gap-2">
          <span className="inline-flex max-w-full items-center gap-2">
            {app.activeRelease ? (
              <button
                type="button"
                onClick={open}
                className="truncate font-mono text-em font-semibold text-foreground hover:underline"
              >
                {app.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </button>
            ) : (
              <span className="truncate font-mono text-em font-semibold text-muted-foreground">
                {app.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </span>
            )}
            <CopyIconButton text={app.url} title="Copy URL" />
          </span>
          {/* The header already states the runtime; only a quiet state (asleep) gets a line of why. */}
          {app.status === 'sleeping' && app.statusDetail && (
            <StatusBadge label={app.statusDetail} color={runtime.color} className="font-normal" />
          )}
          {app.deploying && !app.activeRelease && (
            <button type="button" className="text-left" onClick={() => onGoTo('deployments')}>
              <DeployProgress deploying={app.deploying} />
            </button>
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
              Deployed <span title={new Date(active.createdAt).toLocaleString()}>{relTime(active.createdAt)}</span> by{' '}
              {actorName(active.by)}
            </span>
          </div>
        )}

        <Disclosure label="Details">
          <div className="max-w-[560px]">
            <SpecRow label="App id">
              <span className="inline-flex items-center gap-2">
                {app.appId} <CopyIconButton text={app.appId} title="Copy app id" />
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
            <SpecRow label="Created">
              <span title={new Date(app.createdAt).toLocaleString()}>{relTime(app.createdAt)}</span>
            </SpecRow>
          </div>
        </Disclosure>
      </div>
    </section>
  )
}

export function OverviewTab({
  app,
  onGoTo,
  onRollback,
  onRestartService,
  restarting,
  onOpenDeployment,
}: {
  app: AppDetail
  onGoTo: (tab: AppTab, section?: string, extra?: Record<string, string>) => void
  onRollback: (release: AppRelease) => void
  onRestartService: (service: string) => void
  /** The service being restarted right now, if any. */
  restarting: string | null
  onOpenDeployment: (n: number) => void
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
  const p95 = m ? lastMeasured(m.p95Ms) : null

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
          onOpenDeployment={onOpenDeployment}
          onSetVariable={(name) => onGoTo('variables', undefined, { add: name })}
        />
      )}

      <LiveDeployment app={app} active={active} failing={failing.length > 0} onGoTo={onGoTo} />

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
            No services yet; they start with the next deployment.
          </p>
        ) : (
          <ServicesTable
            services={app.services}
            started={!!app.activeRelease}
            restarting={restarting}
            onRestart={onRestartService}
          />
        )}
      </section>

      {/* Only an app with scheduled jobs has this section. */}
      {app.schedules.length > 0 && (
        <section>
          <SectionTitle title="Schedules" />
          <SchedulesTable app={app} />
        </section>
      )}

      {/* From the app proxy's access log and the sign-in sessions; hidden until there is either. */}
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
                caption: total ? `${errRate.toFixed(2)}% of requests` : undefined,
                tone: errRate > 1 ? 'bad' : 'neutral',
                data: m.errors,
              },
              {
                label: 'p95 latency',
                value: p95 === null ? '—' : String(p95),
                unit: p95 === null ? undefined : 'ms',
                caption: p95 === null ? 'No requests yet' : undefined,
                tone: p95 !== null && p95 > 500 ? 'bad' : 'neutral',
                data: m.p95Ms.map((v) => v ?? 0),
              },
              {
                label: 'Signed-in users',
                value: String(last(m.activeUsers)),
                data: m.activeUsers,
              },
            ]}
          />
        </section>
      )}

      <AgentHandoffPanel app={app} />
    </div>
  )
}
