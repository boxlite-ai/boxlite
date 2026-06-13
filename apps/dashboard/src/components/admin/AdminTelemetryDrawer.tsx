/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  useAdminObservabilityInvestigate,
  type AdminObservabilityClickStackSourceSetup,
  type AdminObservabilityOperation,
} from '@/hooks/useAdminObservability'
import {
  ArrowUpRight,
  Bot,
  CheckCircle2,
  CircleDashed,
  Clipboard,
  ExternalLink,
  Loader2,
  Search,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react'
import React, { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { isErrorState } from './adminHelpers'
import type { AdminDiagnoseTarget } from './adminDiagnoseTarget'
import { AdminStateBadge } from './AdminPrimitives'

interface AdminTelemetryDrawerProps {
  target: AdminDiagnoseTarget | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRecover: (boxId: string) => void
  onCordonRunner?: (runnerId: string) => void
  onDrainRunner?: (runnerId: string) => void
  onJumpToRunner?: (runnerId: string) => void
}

function MetaRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 max-w-[70%] truncate text-right font-medium">{children}</dd>
    </div>
  )
}

function SourceBadge({ state }: { state: string }) {
  const icon =
    state === 'available' ? (
      <CheckCircle2 className="h-3.5 w-3.5" />
    ) : state === 'error' ? (
      <TriangleAlert className="h-3.5 w-3.5" />
    ) : (
      <CircleDashed className="h-3.5 w-3.5" />
    )
  const variant = state === 'available' ? 'success' : state === 'error' ? 'destructive' : 'secondary'

  return (
    <Badge variant={variant} className="gap-1 capitalize">
      {icon}
      {state.replace(/_/g, ' ')}
    </Badge>
  )
}

function CodeCopy({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    toast.success(`${label} copied`)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-muted/30 p-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{value}</code>
        <Button type="button" size="icon-xs" variant="ghost" aria-label={`Copy ${label}`} onClick={copy}>
          {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  )
}

function ClickStackSourceSetupList({ setup }: { setup: AdminObservabilityClickStackSourceSetup[] }) {
  return (
    <div className="basis-full space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="text-xs font-medium text-foreground">ClickStack source setup</div>
      <div className="grid gap-2">
        {setup.map((source) => {
          const tableSummary =
            source.table ??
            Object.values(source.metricTables ?? {})
              .filter(Boolean)
              .join(', ')

          return (
            <div key={source.kind} className="min-w-0 rounded-md border border-border bg-background p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-medium">{source.name}</div>
                <Badge variant="secondary" className="text-[11px]">
                  {source.dataType}
                </Badge>
              </div>
              <div className="mt-1 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
                <div>
                  DB/Table: <code>{source.database}</code>
                  {tableSummary ? (
                    <>
                      {' / '}
                      <code>{tableSummary}</code>
                    </>
                  ) : null}
                </div>
                <div>
                  Timestamp: <code>{source.timestampColumn}</code>
                </div>
                <div className="sm:col-span-2">
                  After saving, put the created source id into <code>{source.envVar}</code>.
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ClickStackLinkButton({ href, label }: { href?: string; label: string }) {
  if (!href) {
    return (
      <Button size="sm" variant="outline" disabled>
        {label}
        <ArrowUpRight className="h-4 w-4" />
      </Button>
    )
  }

  return (
    <Button size="sm" variant="outline" asChild>
      <a href={href} target="_blank" rel="noreferrer">
        {label}
        <ArrowUpRight className="h-4 w-4" />
      </a>
    </Button>
  )
}

function operationButtonLabel(operation: AdminObservabilityOperation) {
  if (operation.state === 'request_only') return 'Request'
  if (operation.state === 'disabled') return 'Unavailable'
  return operation.label
}

function formatWindow(window: { from: Date; to: Date }) {
  const day = window.from.toISOString().slice(0, 10)
  const fromTime = window.from.toISOString().slice(11, 16)
  const toTime = window.to.toISOString().slice(11, 16)
  return `${day} ${fromTime}–${toTime} UTC`
}

function buildFallbackCommands(target: AdminDiagnoseTarget, window: { from: Date; to: Date }) {
  const params = new URLSearchParams()
  params.set('from', window.from.toISOString())
  params.set('to', window.to.toISOString())
  params.set('limit', '100')
  for (const [key, value] of Object.entries(target.params)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  }
  const path = `/admin/observability/investigate?${params.toString()}`
  return {
    api: `GET ${path}`,
    aiAgentPrompt:
      `Use BoxLite Admin API only. Query GET ${path} with header X-BoxLite-Source=agent, ` +
      'then summarize resource, sources, missing reasons, timeline, xLog, audit, and next operations.',
  }
}

const AdminTelemetryDrawer: React.FC<AdminTelemetryDrawerProps> = ({
  target,
  open,
  onOpenChange,
  onRecover,
  onCordonRunner,
  onDrainRunner,
  onJumpToRunner,
}) => {
  const queryWindow = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - 60 * 60 * 1000)
    return { from, to }
  }, [target?.kind, target?.subtitle, open])

  const investigateQuery = useAdminObservabilityInvestigate(
    {
      from: queryWindow.from,
      to: queryWindow.to,
      limit: 100,
      ...target?.params,
    },
    { enabled: open && !!target, retry: false },
  )

  if (!target) return null

  const evidence = investigateQuery.data
  const sources = evidence?.sources ?? []
  const operations = evidence?.operations ?? []
  const timeline = evidence?.timeline ?? []
  const clickstack = evidence?.externalLinks?.clickstack
  const commands = evidence?.commands ?? buildFallbackCommands(target, queryWindow)
  const recoverOperation = operations.find((operation) => operation.id.startsWith('recover:'))
  const cordonOperation = operations.find((operation) => operation.id.startsWith('cordon:'))
  const drainOperation = operations.find((operation) => operation.id.startsWith('drain:'))
  const requestOnlyOperations = operations.filter((operation) => operation.state === 'request_only')
  const hasPartialContract = Boolean(
    evidence &&
      (!evidence.resource ||
        !evidence.externalLinks ||
        !evidence.commands ||
        !evidence.operations ||
        !evidence.timeline),
  )
  const displayTitle = evidence?.resource?.title ?? target.title
  const displaySubtitle =
    evidence?.resource?.subtitle ??
    (hasPartialContract
      ? 'Using Admin inventory context until the Phase B API contract is deployed.'
      : investigateQuery.isLoading
        ? 'Loading diagnosis evidence'
        : target.subtitle)

  const runOperation = (operation: AdminObservabilityOperation) => {
    if (operation.id.startsWith('recover:') && target.box) {
      onRecover(operation.targetId ?? target.box.id)
      return
    }
    if (operation.id.startsWith('cordon:') && operation.targetId) {
      onCordonRunner?.(operation.targetId)
      return
    }
    if (operation.id.startsWith('drain:') && operation.targetId) {
      onDrainRunner?.(operation.targetId)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-dvw flex-col gap-0 p-0 sm:w-[640px] [&>button]:hidden">
        <SheetHeader className="space-y-0 border-b border-border p-4 px-5">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="flex min-w-0 items-center gap-2.5 text-lg font-medium">
              <span className="truncate">{target.title}</span>
              {target.state && <AdminStateBadge state={target.state} />}
            </SheetTitle>
            <Button variant="outline" className="h-8 w-8 shrink-0" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <SheetDescription className="mt-2 truncate text-xs text-muted-foreground">{target.subtitle}</SheetDescription>
        </SheetHeader>

        <div className="m-0 flex-1 space-y-4 overflow-y-auto p-5">
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium">{displayTitle}</h3>
                <p className="mt-1 truncate text-xs text-muted-foreground">{displaySubtitle}</p>
              </div>
              {investigateQuery.isLoading && (
                <Badge variant="secondary" className="gap-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  loading
                </Badge>
              )}
            </div>

            <dl className="space-y-2 text-sm">
              {target.details.map((detail) => {
                const action = detail.action
                return (
                  <MetaRow key={detail.label} k={detail.label}>
                    {action?.type === 'runner' ? (
                      <button
                        type="button"
                        className="block max-w-full truncate text-xs text-primary hover:underline"
                        onClick={() => onJumpToRunner?.(action.id)}
                      >
                        {detail.value}
                      </button>
                    ) : (
                      <span className="text-xs">{detail.value}</span>
                    )}
                  </MetaRow>
                )
              })}
              {target.kind !== 'runner' &&
                target.params.runnerId &&
                !target.details.some((detail) => detail.label === 'runner') && (
                  <MetaRow k="runner">
                    <button
                      type="button"
                      className="block max-w-full truncate text-xs text-primary hover:underline"
                      onClick={() => onJumpToRunner?.(target.params.runnerId as string)}
                    >
                      {target.params.runnerId}
                    </button>
                  </MetaRow>
                )}
            </dl>
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">Evidence sources</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">What is available, missing, or not configured.</p>
                <p className="mt-0.5 text-xs text-muted-foreground" data-testid="diagnose-window-note">
                  Window: {formatWindow(queryWindow)} (last 1h). Signals outside it (e.g. CloudWatch retains longer) are
                  not shown — an empty source here may mean “outside this window”, not “no data”.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => investigateQuery.refetch()}>
                <Search className="h-4 w-4" />
                Refresh
              </Button>
            </div>

            {investigateQuery.isError && (
              <div className="rounded-md border border-destructive/30 bg-destructive-background p-3 text-xs text-destructive-foreground">
                Failed to load diagnosis evidence.
              </div>
            )}
            {hasPartialContract && (
              <div className="rounded-md border border-warning-separator bg-warning-background p-3 text-xs text-warning-foreground">
                Admin Diagnose is using an older backend response. Deploy the Phase B API contract to enable ClickStack
                links, operations, commands, and timeline evidence.
              </div>
            )}

            <div className="grid gap-2">
              {sources.map((source) => (
                <div
                  key={source.source}
                  className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium capitalize">{source.source}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {source.message ?? `${source.count ?? 0} related item${source.count === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <SourceBadge state={source.state} />
                </div>
              ))}
              {!evidence && !investigateQuery.isLoading && (
                <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  Open this drawer from a real box to resolve telemetry, platform state, audit, and xLog evidence.
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-medium">Human deep links</h3>
            <p className="text-xs text-muted-foreground">
              BoxLite keeps context, permission, and audit here. ClickStack is for detailed logs, traces, and metrics.
            </p>
            <div className="flex flex-wrap gap-2">
              {clickstack?.configured ? (
                <>
                  <ClickStackLinkButton href={clickstack.dashboardUrl} label="Dashboard" />
                  <ClickStackLinkButton href={clickstack.logsUrl} label="Logs" />
                  <ClickStackLinkButton href={clickstack.tracesUrl} label="Traces" />
                  <ClickStackLinkButton href={clickstack.metricsUrl} label="Metrics" />
                  {clickstack.message && (
                    <div className="basis-full rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                      {clickstack.message}
                    </div>
                  )}
                  {clickstack.sourceSetup && clickstack.sourceSetup.length > 0 && (
                    <ClickStackSourceSetupList setup={clickstack.sourceSetup} />
                  )}
                </>
              ) : (
                <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  {clickstack?.message ?? 'ClickStack links are not available from the current backend response yet.'}
                </div>
              )}
            </div>
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-medium">Admin API and AI Agent</h3>
            <CodeCopy label="Admin API" value={commands.api} icon={<ExternalLink className="h-3.5 w-3.5" />} />
            <CodeCopy label="AI Agent" value={commands.aiAgentPrompt} icon={<Bot className="h-3.5 w-3.5" />} />
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-medium">Operations</h3>
            <div className="flex flex-wrap gap-2">
              {[recoverOperation, cordonOperation, drainOperation]
                .filter((operation): operation is AdminObservabilityOperation => Boolean(operation))
                .map((operation) => (
                  <Button
                    key={operation.id}
                    size="sm"
                    variant={
                      operation.id.startsWith('recover:') && target.box && isErrorState(target.box.state)
                        ? 'default'
                        : 'outline'
                    }
                    disabled={operation.state !== 'enabled'}
                    onClick={() => runOperation(operation)}
                  >
                    {operation.id.startsWith('recover:') && <Wrench className="h-4 w-4" />}
                    {operationButtonLabel(operation)}
                  </Button>
                ))}
            </div>
            {operations.length === 0 && (
              <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                No operations are available for this context yet.
              </div>
            )}
            {requestOnlyOperations.length > 0 && (
              <div className="grid gap-2">
                {requestOnlyOperations.map((operation) => (
                  <div key={operation.id} className="rounded-md border border-border bg-muted/20 p-3 text-xs">
                    <div className="font-medium">{operation.label}</div>
                    <div className="mt-1 text-muted-foreground">{operation.reason}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Timeline</h3>
              <span className="text-xs text-muted-foreground">{timeline.length} events</span>
            </div>
            <div className="space-y-2">
              {timeline.slice(0, 12).map((event, index) => (
                <div key={`${event.timestamp}-${event.source}-${index}`} className="rounded-md bg-muted/20 p-3 text-xs">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                    <div className="font-medium">{event.title}</div>
                    <div className="text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</div>
                  </div>
                  <div className="mt-1 line-clamp-2 text-muted-foreground">{event.detail ?? event.source}</div>
                </div>
              ))}
              {evidence && timeline.length === 0 && (
                <div className="rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
                  No timeline events were found for this context. Check source status above for missing data reasons.
                </div>
              )}
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default AdminTelemetryDrawer
