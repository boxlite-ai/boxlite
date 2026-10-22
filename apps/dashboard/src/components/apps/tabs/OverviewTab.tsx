/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { STATUS } from '@/lib/apps/format'
import type { AppDetail, AppProblem, AppRelease, AppTab } from '@/lib/apps/types'
import { toast } from 'sonner'
import { AgentHandoffPanel } from '../AgentHandoffPanel'
import { HandoffToAgent } from '../HandoffToAgent'
import { LiveCard, StackDiagram } from '../OverviewHero'
import { copyText, Disclosure, FlatButton, PromptBlock, StatusBadge } from '../spec'
import { TrafficPanel } from '../TrafficPanel'

// Overview answers three things, in this order: does anything need you, what
// is live right now and what the agent built behind it (OverviewHero.tsx), and
// how it is doing. Process ids and exit codes live inside each
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

/** A new environment is not a broken one: nothing red, one task, one action. */

export function OverviewTab({
  app,
  onGoTo,
  onRollback,
  onOpenDeployment,
}: {
  app: AppDetail
  onGoTo: (tab: AppTab, section?: string, extra?: Record<string, string>) => void
  onRollback: (release: AppRelease) => void
  onOpenDeployment: (n: number) => void
}) {
  const active = app.releases.find((r) => r.id === app.activeRelease) ?? null
  // The newest earlier deployment that can still go live again.
  const previous = app.releases.find((r) => !r.current && r.rollback.possible) ?? null
  const failing = app.problems
  const m = app.metrics

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

      <LiveCard app={app} active={active} failing={failing.length > 0} onGoTo={onGoTo} />

      <StackDiagram app={app} onGoTo={onGoTo} />

      {/* From the app proxy's access log and the sign-in sessions; hidden until there is either. */}
      {m && <TrafficPanel metrics={m} />}

      <AgentHandoffPanel app={app} />
    </div>
  )
}
