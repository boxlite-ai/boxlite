/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Skeleton } from '@/components/ui/skeleton'
import { ChevronRight } from 'lucide-react'
import React, { useMemo } from 'react'
import { groupBoxesByOwner, isOnlineRunner, runnerCpuPercent, selectErroringOwners } from './adminHelpers'
import AdminPlatformTelemetryView from './AdminPlatformTelemetryView'
import { AdminSectionFrame } from './AdminPrimitives'
import { useAdminBoxes, useAdminRunners } from './useAdminData'

const PLATFORM_TELEMETRY_TARGET = 'boxlite-api'
const PLATFORM_TELEMETRY_PANEL_ID = 'admin-platform-telemetry-panel'

interface AdminOverviewViewProps {
  onJumpToOwner: (ownerName: string) => void
  onJumpToRunner: (runnerId: string) => void
  onDiagnoseTrace: (traceId: string) => void
  onDiagnoseExecution: (executionId: string, traceId?: string) => void
  onDiagnoseJob: (jobId: string, traceId?: string) => void
  onDiagnoseRequest: (requestId: string, traceId?: string) => void
}

function AttentionRow({
  color,
  title,
  subtitle,
  action,
  onClick,
}: {
  color: string
  title: React.ReactNode
  subtitle: string
  action: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 border-t border-border px-4 py-3 text-left transition-colors first:border-t-0 hover:bg-muted/40"
    >
      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
      <span className="min-w-0 flex-1">
        <span className="text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
      </span>
      <span className="inline-flex items-center gap-1 text-xs text-primary">
        {action}
        <ChevronRight className="h-3.5 w-3.5" />
      </span>
    </button>
  )
}

function NeedsAttentionPanel({
  isBoxesPending,
  erroringOwners,
  isRunnersPending,
  staleRunners,
  hotRunners,
  onJumpToOwner,
  onJumpToRunner,
}: {
  isBoxesPending: boolean
  erroringOwners: ReturnType<typeof selectErroringOwners>
  isRunnersPending: boolean
  staleRunners: ReturnType<typeof useAdminRunners>['data']
  hotRunners: ReturnType<typeof useAdminRunners>['data']
  onJumpToOwner: (ownerName: string) => void
  onJumpToRunner: (runnerId: string) => void
}) {
  const hasRunnerAlerts = Boolean(staleRunners?.length || hotRunners?.length)
  const hasAlerts = erroringOwners.length > 0 || hasRunnerAlerts

  return (
    <AdminSectionFrame
      title="Needs Attention"
      description="Actionable box and fleet items stay close to platform health."
      className="bg-background/80"
      contentClassName="p-0"
    >
      {isBoxesPending || isRunnersPending ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : !hasAlerts ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">No active attention items.</p>
      ) : (
        <>
          {erroringOwners.map(({ group, errorBoxes }) => (
            <AttentionRow
              key={group.organizationId}
              color="#dd7d70"
              title={group.owner.name}
              subtitle={`${errorBoxes.length} box(es) need recovery · ${errorBoxes.map((b) => b.id).join(', ')}`}
              action="view"
              onClick={() => onJumpToOwner(group.owner.name)}
            />
          ))}
          {staleRunners?.map((r) => (
            <AttentionRow
              key={r.id}
              color="#838b97"
              title={<span className="break-all">{r.id}</span>}
              subtitle={`${r.state} · outside READY state`}
              action="drain"
              onClick={() => onJumpToRunner(r.id)}
            />
          ))}
          {hotRunners?.map((r) => (
            <AttentionRow
              key={r.id}
              color="#d6a84f"
              title={<span className="break-all">{r.id}</span>}
              subtitle={`${Math.round(runnerCpuPercent(r) * 100)}% CPU · nearly full`}
              action="view"
              onClick={() => onJumpToRunner(r.id)}
            />
          ))}
        </>
      )}
    </AdminSectionFrame>
  )
}

function PlatformTelemetryScopeSection() {
  const focusTelemetry = () => {
    document.getElementById(PLATFORM_TELEMETRY_PANEL_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <button
      type="button"
      onClick={focusTelemetry}
      className="group flex w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/80 px-4 py-3 text-left shadow-sm transition-colors hover:border-border hover:bg-background sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="min-w-0 space-y-1">
        <span className="block text-sm font-semibold">Platform-scoped evidence</span>
        <span className="block text-sm text-muted-foreground">
          Global boxlite-api metrics first, with logs and traces available for deeper API and control-plane debugging.
        </span>
        <span className="block text-xs text-muted-foreground">
          Not per-box runtime telemetry. Use People & Boxes or Fleet for object ownership and placement.
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="rounded-md bg-muted/70 px-3 py-2 text-xs font-medium text-foreground">
          service.name={PLATFORM_TELEMETRY_TARGET}
        </span>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
          open
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </span>
    </button>
  )
}

const AdminOverviewView: React.FC<AdminOverviewViewProps> = ({
  onJumpToOwner,
  onJumpToRunner,
  onDiagnoseTrace,
  onDiagnoseExecution,
  onDiagnoseJob,
  onDiagnoseRequest,
}) => {
  const boxesQuery = useAdminBoxes()
  const runnersQuery = useAdminRunners()

  const boxes = boxesQuery.data ?? []
  const erroringOwners = useMemo(() => selectErroringOwners(groupBoxesByOwner(boxes)), [boxes])

  const runners = runnersQuery.data ?? []
  const staleRunners = useMemo(() => runners.filter((r) => !isOnlineRunner(r)), [runners])
  const hotRunners = useMemo(() => runners.filter((r) => isOnlineRunner(r) && runnerCpuPercent(r) >= 0.8), [runners])

  return (
    <div className="space-y-6">
      <PlatformTelemetryScopeSection />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,19rem)]">
        <div id={PLATFORM_TELEMETRY_PANEL_ID} className="scroll-mt-6">
          <AdminPlatformTelemetryView
            onDiagnoseTrace={onDiagnoseTrace}
            onDiagnoseExecution={onDiagnoseExecution}
            onDiagnoseJob={onDiagnoseJob}
            onDiagnoseRequest={onDiagnoseRequest}
          />
        </div>
        <NeedsAttentionPanel
          isBoxesPending={boxesQuery.isPending}
          erroringOwners={erroringOwners}
          isRunnersPending={runnersQuery.isPending}
          staleRunners={staleRunners}
          hotRunners={hotRunners}
          onJumpToOwner={onJumpToOwner}
          onJumpToRunner={onJumpToRunner}
        />
      </div>
    </div>
  )
}

export default AdminOverviewView
