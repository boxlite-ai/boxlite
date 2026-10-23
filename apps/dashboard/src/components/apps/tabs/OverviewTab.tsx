/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArrowRightIcon, GitBranch } from '@/components/ui/icon'
import { useAppEnvironments } from '@/hooks/queries/useAppsQuery'
import { appStatusOf, relTime, STATUS } from '@/lib/apps/format'
import type { AppDetail, AppProblem, AppRelease, AppTab } from '@/lib/apps/types'
import { toast } from 'sonner'
import { AgentHandoffPanel } from '../AgentHandoffPanel'
import { HandoffToAgent } from '../HandoffToAgent'
import { LiveCard } from '../OverviewHero'
import { copyText, Disclosure, FlatButton, PromptBlock, StatusBadge } from '../spec'
import { TrafficPanel } from '../TrafficPanel'

// Overview answers three things, in this order: does anything need you, what
// is live right now (OverviewHero.tsx), and how it is doing. Process ids and exit codes live inside each
// service row. One primary action per state: open the app when healthy, copy
// the fix when broken, hand the app to the agent when nothing is deployed.

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

/**
 * An environment with nothing deployed, while others of the App are live (an agent tried things
 * in a test environment first): say where the app runs now, one click away.
 */
function LiveElsewhere({ app, onSwitchEnv }: { app: AppDetail; onSwitchEnv: (env: string) => void }) {
  const { data: envs = [] } = useAppEnvironments(app.id)
  const live = envs.filter((e) => e.name !== app.environment && e.lastDeploy)
  if (!live.length) return null
  return (
    <section className="flex flex-col border border-border bg-card font-mono">
      <div className="border-b border-border px-5 py-3 text-[13px] text-muted-foreground">
        Nothing is deployed to {app.environment} yet. {app.name} runs in{' '}
        {live.length === 1 ? 'another environment' : `${live.length} other environments`}:
      </div>
      {live.map((e) => {
        const status = appStatusOf(e.status)
        return (
          <button
            key={e.name}
            type="button"
            onClick={() => onSwitchEnv(e.name)}
            className="group flex items-center gap-4 border-b border-border/60 px-5 py-3 text-left last:border-b-0 hover:bg-background/40"
          >
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-semibold text-foreground">{e.name}</span>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <span className="size-[6px]" style={{ background: status.color }} />
              {status.label}
            </span>
            <span className="text-[12px] text-muted-foreground">
              {e.lastDeploy!.releaseId} · deployed {relTime(e.lastDeploy!.at)}
            </span>
            <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-foreground group-hover:underline">
              Go to {e.name} <ArrowRightIcon className="size-3.5" />
            </span>
          </button>
        )
      })}
    </section>
  )
}

export function OverviewTab({
  app,
  onGoTo,
  onRollback,
  onOpenDeployment,
  onSwitchEnv,
}: {
  app: AppDetail
  onGoTo: (tab: AppTab, section?: string, extra?: Record<string, string>) => void
  onRollback: (release: AppRelease) => void
  onOpenDeployment: (n: number) => void
  onSwitchEnv: (env: string) => void
}) {
  const active = app.releases.find((r) => r.id === app.activeRelease) ?? null
  // The newest earlier deployment that can still go live again.
  const previous = app.releases.find((r) => !r.current && r.rollback.possible) ?? null
  const failing = app.problems
  const m = app.metrics

  if (app.status === 'draft') {
    return (
      <div className="flex flex-col gap-8">
        <LiveElsewhere app={app} onSwitchEnv={onSwitchEnv} />
        <HandoffToAgent app={app} />
      </div>
    )
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

      <LiveCard app={app} active={active} failing={failing.length > 0} onGoTo={onGoTo} />

      {/* From the app proxy's access log and the sign-in sessions; hidden until there is either. */}
      {m && <TrafficPanel metrics={m} />}

      <AgentHandoffPanel app={app} />
    </div>
  )
}
