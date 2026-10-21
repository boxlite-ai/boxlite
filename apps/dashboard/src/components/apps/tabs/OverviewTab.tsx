/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { appStatusOf, relTime, STATUS } from '@/lib/apps/format'
import { openApp } from '@/lib/apps/open'
import type { AppDetail, AppProblem, AppRelease, AppTab } from '@/lib/apps/types'
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
import { MetricStrip } from '../viz'

// Overview answers three things, in this order: does anything need you, what
// is live right now, and how it is doing. Identity (app id, image, created) is
// one click away under Details; process ids and exit codes live inside each
// service row. One primary action per state: open the app when healthy, copy
// the fix when broken, hand the app to the agent when nothing is deployed.

const sum = (data: number[]) => data.reduce((a, b) => a + b, 0)
const last = (data: number[]) => data[data.length - 1] ?? 0

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
}: {
  app: AppDetail
  failing: AppProblem[]
  previous: AppRelease | null
  onRollback: (release: AppRelease) => void
  onOpenLogs: () => void
  onOpenDeployment: (n: number) => void
}) {
  const prompt = failing
    .map((problem) => problem.fixPrompt)
    .filter(Boolean)
    .join('\n\n')
  const failedDeployment = failing.find((p) => p.deployment)?.deployment
  // A failed deployment with an older release still serving needs a fix, not a rollback.
  const serving = failing.find((p) => p.serving)?.serving
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
        {prompt && (
          <FlatButton
            variant="primary"
            onClick={() => copyWithNotice(prompt, `Copied fix instructions for ${app.name} · ${app.environment}`)}
          >
            Copy fix instructions for your agent
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
            {app.activeRelease ? (
              <button
                type="button"
                onClick={() => void openApp(app.id, app.environment)}
                className="truncate font-mono text-em font-semibold text-foreground hover:underline"
              >
                {app.url.replace(/^https?:\/\//, '')}
              </button>
            ) : (
              <span className="truncate font-mono text-em font-semibold text-muted-foreground">
                {app.url.replace(/^https?:\/\//, '')}
              </span>
            )}
            <CopyIconButton text={app.url} />
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

export function OverviewTab({
  app,
  onGoTo,
  onRollback,
  onRestartService,
  restarting,
  onOpenDeployment,
}: {
  app: AppDetail
  onGoTo: (tab: AppTab, section?: string) => void
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
          <div className="flex flex-col gap-3 font-mono text-[13px] text-muted-foreground">
            <span>No service declared yet. Your agent adds one to boxlite.toml and deploys:</span>
            <PromptBlock
              text={
                '[[service]]\nname = "web"\ncommand = "node server.js"\nport = 3000\nhealth = "/healthz"\n\n# then: boxlite-app deploy'
              }
              compact
            />
          </div>
        ) : (
          <ServicesTable
            services={app.services}
            started={!!app.activeRelease}
            restarting={restarting}
            onRestart={onRestartService}
          />
        )}
      </section>

      <section>
        <SectionTitle title="Schedules" count={app.schedules.length || undefined} />
        {app.schedules.length === 0 ? (
          <p className="font-mono text-[13px] text-muted-foreground">
            No schedules. A [[schedule]] in boxlite.toml (name, cron, target = &quot;web:/jobs/…&quot;) runs a POST on
            your app; it starts with the next <code>boxlite-app deploy</code>.
          </p>
        ) : (
          <SchedulesTable app={app} />
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
