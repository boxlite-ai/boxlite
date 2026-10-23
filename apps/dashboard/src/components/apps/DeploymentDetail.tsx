/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Spinner } from '@/components/ui/spinner'
import { useDeployment } from '@/hooks/queries/useAppsQuery'
import { downloadUrl, errorText } from '@/lib/apps/client'
import { actorName, capitalize, formatBytes, formatDuration, releaseStatusOf, relTime, STATUS } from '@/lib/apps/format'
import {
  RELEASE_IN_PROGRESS,
  type AppDetail,
  type AppRelease,
  type DeploymentDetail as Detail,
  type TimelineStep,
} from '@/lib/apps/types'
import { cn } from '@/lib/utils'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import {
  copyText,
  Disclosure,
  EmptyNote,
  FlatButton,
  GridHeader,
  PromptBlock,
  SectionTitle,
  SpecRow,
  StatusBadge,
} from './spec'
import { ToolButton } from './SubNav'
import { useElapsed } from './useElapsed'
import { Tag } from './viz'

// One deployment, traceable end to end: who started it and what it changed, every step with its
// start time and duration, the classified cause when it failed (with instructions to hand to the
// agent), and every log line it produced. A running deployment is followed live.

const STEP_GRID = 'grid-cols-[120px_120px_150px_100px_minmax(0,1fr)] gap-x-4'

function stepState(step: TimelineStep): { label: string; color: string } {
  if (step.status === 'done') return { label: 'Done', color: STATUS.running }
  if (step.status === 'failed') return { label: 'Failed', color: STATUS.error }
  if (step.status === 'skipped') return { label: 'Skipped', color: STATUS.dim }
  return { label: 'Running', color: STATUS.idle }
}

function StepRow({ step }: { step: TimelineStep }) {
  const running = step.status === 'running'
  const elapsed = useElapsed(running ? step.startedAt : null)
  const state = stepState(step)
  return (
    <div
      className={cn(
        `grid ${STEP_GRID} min-h-[40px] items-center border-b border-border/60 px-2 font-mono text-body`,
        running && 'bg-warning/[0.04]',
      )}
      data-testid={`step-${step.name}`}
    >
      <span className="text-foreground">{capitalize(step.name)}</span>
      {running ? (
        <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.5px] text-warning">
          <Spinner className="size-[11px]" /> Running
        </span>
      ) : (
        <StatusBadge label={state.label} color={state.color} caps />
      )}
      <span className="tabular-nums text-muted-foreground" title={step.startedAt ?? undefined}>
        {step.startedAt ? new Date(step.startedAt).toLocaleTimeString('en-US', { hour12: false }) : '—'}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {running ? (elapsed ?? '…') : step.ms !== null ? formatDuration(step.ms) : '—'}
      </span>
      <span
        className={cn('truncate', step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
        title={step.detail ?? undefined}
      >
        {step.detail ?? ''}
      </span>
    </div>
  )
}

function Failure({ detail, f }: { detail: Detail; f: NonNullable<Detail['failure']> }) {
  return (
    <section
      className="border border-destructive/40 bg-destructive/[0.04] px-5 py-4 font-mono"
      data-testid="deployment-failure"
    >
      <StatusBadge
        label={`Failed at ${f.step}: ${f.summary}`}
        color={STATUS.error}
        className="text-body font-semibold"
      />
      <div className="mt-2 flex flex-col gap-1 pl-[15px] text-[13px]">
        {/* The fix itself is written for the agent (commands, config fields): it is in the instructions below. */}
        <span className="text-foreground">
          <span className="text-muted-foreground">Fix · </span>
          your coding agent can fix this: copy the instructions below and paste them to it
        </span>
        {f.file && (
          <span className="text-muted-foreground">
            File ·{' '}
            <span className="text-foreground">
              {f.file}
              {f.line !== undefined ? `:${f.line}` : ''}
            </span>
          </span>
        )}
        <span className="text-muted-foreground">Cause · {f.cause.replace(/_/g, ' ')}</span>
      </div>
      {f.evidence.length > 0 && (
        <pre className="ml-[15px] mt-3 max-h-[160px] overflow-auto bg-card/60 px-3 py-2 text-[12px] leading-[1.6] text-muted-foreground">
          {f.evidence.join('\n')}
        </pre>
      )}
      <div className="mt-4 flex flex-wrap gap-1 pl-[15px]">
        <FlatButton
          variant="primary"
          onClick={() => {
            copyText(f.fixPrompt)
            toast.success(`Copied fix instructions for ${detail.id}`, {
              description: 'Paste them into your coding agent.',
            })
          }}
        >
          Copy fix instructions for your agent
        </FlatButton>
      </div>
      <div className="mt-3 pl-[15px]">
        <Disclosure label="Show instructions">
          <PromptBlock text={f.fixPrompt} compact />
        </Disclosure>
      </div>
    </section>
  )
}

function Changes({ detail }: { detail: Detail }) {
  const { infrastructure, configuration, code } = detail.changeSet
  if (!infrastructure.length && !configuration.length && !code)
    return <p className="text-[13px] text-muted-foreground">Nothing changed.</p>
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[1px] text-muted-foreground">{title}</span>
        {items.map((item) => (
          <span
            key={item}
            className={cn('text-[13px]', item.startsWith('Removed') ? 'text-destructive' : 'text-foreground')}
          >
            {item}
          </span>
        ))}
      </div>
    )
  return (
    <div className="grid gap-6 font-mono md:grid-cols-3">
      {list('Services & data', infrastructure)}
      {list('Settings', configuration)}
      {code && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[1px] text-muted-foreground">Code</span>
          <span className="text-[13px] text-foreground" data-testid="code-changes">
            <span className="text-success">+{code.added} added</span> ·{' '}
            <span className="text-warning">~{code.changed} changed</span> ·{' '}
            <span className="text-destructive">−{code.removed} removed</span>
          </span>
          <span className="text-[12px] text-muted-foreground">
            {code.files} files uploaded{code.comparedWith ? `, compared with #${code.comparedWith}` : ', first upload'}
          </span>
        </div>
      )}
    </div>
  )
}

function Log({ detail }: { detail: Detail }) {
  const ref = useRef<HTMLPreElement>(null)
  const running = RELEASE_IN_PROGRESS.includes(detail.status)
  // While it runs, keep the newest line in view.
  useEffect(() => {
    if (running && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [detail.log.length, running])
  if (detail.log.length === 0)
    return <EmptyNote title="No log lines yet">They appear here as the deployment runs.</EmptyNote>
  return (
    <pre
      ref={ref}
      className="max-h-[520px] overflow-auto bg-card/60 px-4 py-3 font-mono text-[12px] leading-[1.75]"
      data-testid="deployment-log"
    >
      {detail.log.map((l) => (
        <div
          key={l.id}
          className={cn(
            l.level === 'error' ? 'text-destructive' : l.level === 'warn' ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          <span className="text-muted-foreground/60">
            {new Date(l.ts).toLocaleTimeString('en-US', { hour12: false })}
          </span>{' '}
          <span className="text-muted-foreground">[{l.source}]</span> {l.line}
        </div>
      ))}
      {detail.logTruncated && <div className="text-warning">… earlier lines are not shown (5000 line limit)</div>}
    </pre>
  )
}

export function DeploymentDetail({
  app,
  number,
  onBack,
  onRollback,
  onOpenLogs,
}: {
  app: AppDetail
  number: number
  onBack: () => void
  onRollback: (release: AppRelease) => void
  onOpenLogs: (n: number) => void
}) {
  const { data: detail, isLoading, error } = useDeployment(app.id, number)
  const elapsed = useElapsed(
    detail && RELEASE_IN_PROGRESS.includes(detail.status) ? (detail.startedAt ?? detail.createdAt) : null,
  )
  const back = (
    <button
      type="button"
      onClick={onBack}
      className="self-start font-mono text-[12px] text-muted-foreground hover:text-foreground"
    >
      ← All deployments
    </button>
  )
  if (error) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <EmptyNote title={`Deployment #${number} could not be loaded`}>{errorText(error)}</EmptyNote>
      </div>
    )
  }
  if (isLoading || !detail) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <div className="flex items-center gap-2 font-mono text-[13px] text-muted-foreground">
          <Spinner className="size-4" /> Loading #{number}…
        </div>
      </div>
    )
  }
  const status = releaseStatusOf(detail.status)
  const took = detail.finishedAt
    ? formatDuration(Date.parse(detail.finishedAt) - Date.parse(detail.startedAt ?? detail.createdAt))
    : elapsed
  const source = `/apps/${encodeURIComponent(app.id)}/deployments/${detail.number}/source?env=${encodeURIComponent(app.environment)}`
  return (
    <div className="flex flex-col gap-8" data-testid="deployment-detail">
      <div className="flex flex-col gap-3">
        {back}
        {/* The brief: what this deployment is, how it went, and what it changed. */}
        <section className="border border-border bg-card">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-[22px] py-4">
            <h2 className="font-mono text-em font-semibold text-foreground">{detail.id}</h2>
            <StatusBadge label={status.label} color={status.color} caps />
            {detail.current && <Tag tone="brand">Current</Tag>}
            <span className="min-w-0 truncate font-mono text-body text-foreground">{detail.summary}</span>
            <span className="ml-auto flex flex-wrap gap-1">
              {detail.rollback.possible && (
                <ToolButton onClick={() => onRollback(detail)}>Roll back to {detail.id}</ToolButton>
              )}
              <ToolButton onClick={() => onOpenLogs(detail.number)}>View in Logs</ToolButton>
              {detail.hasSource && (
                <a
                  href={downloadUrl(source)}
                  download
                  className="inline-flex h-[28px] items-center border border-border px-[10px] font-mono text-[12px] text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
                >
                  Download source
                </a>
              )}
            </span>
          </div>
          <div className="flex flex-col gap-5 px-[22px] py-[18px] font-mono">
            <span className="text-[13px] text-muted-foreground">
              {detail.rollbackTo !== null ? `Rolled back to #${detail.rollbackTo}` : 'Deployed'}{' '}
              <span title={new Date(detail.createdAt).toLocaleString('en-US')}>{relTime(detail.createdAt)}</span> by{' '}
              {actorName(detail.by, { short: true })}
              {took ? ` · ${detail.finishedAt ? 'took' : 'running for'} ${took}` : ''}
            </span>
            <div className="flex flex-col gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-muted-foreground">
                <span className="text-brand">▸</span> What changed
              </span>
              <Changes detail={detail} />
            </div>
          </div>
        </section>
      </div>

      {detail.failure && <Failure detail={detail} f={detail.failure} />}

      <section>
        <SectionTitle title="Steps" count={detail.timeline.length || undefined} />
        {detail.timeline.length === 0 ? (
          <p className="font-mono text-[13px] text-muted-foreground">
            Queued: it starts when the deployment before it finishes.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <GridHeader grid={STEP_GRID} columns={['Step', 'Status', 'Started', 'Duration', 'Detail']} />
              {detail.timeline.map((step) => (
                <StepRow key={step.name} step={step} />
              ))}
            </div>
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="Log" count={`${detail.log.length} lines`} />
        <Log detail={detail} />
      </section>

      <Disclosure label="Details">
        <div className="max-w-[640px]">
          <SpecRow label="Created">{new Date(detail.createdAt).toLocaleString('en-US')}</SpecRow>
          <SpecRow label="Started by">{detail.by}</SpecRow>
          <SpecRow label="Configuration">
            {detail.specVersion !== null ? `version ${detail.specVersion}` : 'not written yet'}
            {detail.baseVersion ? ` (planned against v${detail.baseVersion})` : ''}
          </SpecRow>
          {detail.files !== null && detail.bytes !== null && (
            <SpecRow label="Upload">
              {detail.files} files · {formatBytes(detail.bytes)}
            </SpecRow>
          )}
          {detail.restorePoint && (
            <SpecRow label="Database restore point">{new Date(detail.restorePoint).toLocaleString('en-US')}</SpecRow>
          )}
          {!detail.current && !detail.rollback.possible && detail.rollback.reason && (
            <SpecRow label="Rollback">{detail.rollback.reason}</SpecRow>
          )}
        </div>
      </Disclosure>
    </div>
  )
}
