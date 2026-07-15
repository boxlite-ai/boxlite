/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type AdminBox, findBoxById, groupBoxesByOwner } from '@/components/admin/adminHelpers'
import {
  createBoxDiagnoseTarget,
  createExecutionDiagnoseTarget,
  createJobDiagnoseTarget,
  createMachineDiagnoseTarget,
  createOwnerGroupDiagnoseTarget,
  createRequestDiagnoseTarget,
  createRunnerDiagnoseTarget,
  createTraceDiagnoseTarget,
  type AdminDiagnoseTarget,
} from '@/components/admin/adminDiagnoseTarget'
import AdminFleetView from '@/components/admin/AdminFleetView'
import AdminOverviewView from '@/components/admin/AdminOverviewView'
import AdminPeopleBoxesView from '@/components/admin/AdminPeopleBoxesView'
import AdminStatusStrip from '@/components/admin/AdminStatusStrip'
import AdminTelemetryDrawer from '@/components/admin/AdminTelemetryDrawer'
import { ADMIN_VIEWS, adminViewFromParam, type AdminView } from '@/components/admin/adminNavigation'
import { useAdminActions, useAdminBoxes, useAdminOverview, useAdminRunners } from '@/components/admin/useAdminData'
import { RoutePath } from '@/enums/RoutePath'
import { cn } from '@/lib/utils'
import { Activity, Search, Server, UsersRound, type LucideIcon } from '@/components/ui/icon'
import React, { useEffect, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'

const ADMIN_VIEW_ICONS: Record<AdminView, LucideIcon> = {
  overview: Activity,
  people: UsersRound,
  fleet: Server,
}

const Admin: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const viewFromParams = adminViewFromParam(searchParams.get('view')) ?? 'overview'
  const [view, setViewState] = useState<AdminView>(viewFromParams)
  const [query, setQuery] = useState('')
  const [runnerFilter, setRunnerFilter] = useState<string | null>(null)
  const [highlightRunner, setHighlightRunner] = useState<string | null>(null)
  const [diagnoseTarget, setDiagnoseTarget] = useState<AdminDiagnoseTarget | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const overviewQuery = useAdminOverview()
  const boxesQuery = useAdminBoxes()
  const runnersQuery = useAdminRunners()
  const { cordon, drain, recover } = useAdminActions()

  useEffect(() => {
    setViewState(viewFromParams)
  }, [viewFromParams])

  const setView = (nextView: AdminView) => {
    setViewState(nextView)
    const nextParams = new URLSearchParams(searchParams)
    if (nextView === 'overview') {
      nextParams.delete('view')
    } else {
      nextParams.set('view', nextView)
    }
    setSearchParams(nextParams, { replace: true })
  }

  // 403 gate — non-admins are redirected (backend is the real guard).
  if (overviewQuery.isError && (overviewQuery.error as { response?: { status?: number } })?.response?.status === 403) {
    return <Navigate to={RoutePath.DASHBOARD} replace />
  }

  const openDiagnoseTarget = (target: AdminDiagnoseTarget) => {
    setDiagnoseTarget(target)
    setDrawerOpen(true)
  }

  const openBox = (box: AdminBox) => openDiagnoseTarget(createBoxDiagnoseTarget(box))

  const handleSearchChange = (value: string) => {
    setQuery(value)
    setRunnerFilter(null)
    if (value) setView('people')

    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return

    // Pasting a full box id jumps straight into the box detail drawer. Real box ids are
    // UUIDs in dev, while older mockups used box-* ids.
    const boxHit = findBoxById(groupBoxesByOwner(boxesQuery.data ?? []), trimmed)
    if (boxHit) {
      openBox(boxHit.box)
      return
    }

    const runnerHit = runnersQuery.data?.find((runner) => runner.id.toLowerCase().includes(trimmed))
    if (runnerHit) {
      setHighlightRunner(runnerHit.id)
      setView('fleet')
    }
  }

  const jumpToOwner = (ownerName: string) => {
    setRunnerFilter(null)
    setQuery(ownerName)
    setView('people')
  }

  const jumpToRunner = (runnerId: string) => {
    setDrawerOpen(false)
    setQuery('')
    setRunnerFilter(null)
    setHighlightRunner(runnerId)
    setView('fleet')
  }

  const showRunnerBoxes = (runnerId: string) => {
    setQuery('')
    setRunnerFilter(runnerId)
    setView('people')
  }

  const recoverBox = (boxId: string) => {
    recover.mutate(boxId)
    setDrawerOpen(false)
  }

  const cordonRunner = (runnerId: string) => {
    const runner = runnersQuery.data?.find((candidate) => candidate.id === runnerId)
    if (runner) cordon.mutate(runner)
  }

  const drainRunner = (runnerId: string) => {
    drain.mutate(runnerId)
  }

  return (
    <div className="px-[34px] pb-[26px] pt-[26px] font-mono lg:px-[40px]">
      <h2 className="mb-5 text-[13px] font-medium uppercase tracking-[3px] text-muted-foreground">Admin</h2>

      <AdminStatusStrip />

      {/* toolbar: view switch + global search */}
      <div className="mt-6 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <nav aria-label="Admin views" className="flex w-full border border-border xl:max-w-xl">
          {ADMIN_VIEWS.map((v) => {
            const Icon = ADMIN_VIEW_ICONS[v.id]
            const isActive = view === v.id
            return (
              <button
                key={v.id}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setView(v.id)}
                className={cn(
                  'relative flex flex-1 items-center justify-center gap-2 border-r border-border px-4 py-[11px] text-[13px] font-medium transition-colors last:border-r-0',
                  isActive ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground',
                  isActive &&
                    'after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-brand after:content-[""]',
                )}
              >
                <Icon className="size-[15px]" />
                <span>{v.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="flex w-full items-center gap-[11px] border border-border bg-card px-[14px] py-[9px] sm:max-w-xs">
          <Search className="size-[15px] shrink-0" style={{ color: 'hsl(var(--brand))' }} strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search users, boxes, runners…"
            className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="mt-6">
        {view === 'overview' && (
          <AdminOverviewView
            onJumpToOwner={jumpToOwner}
            onJumpToRunner={jumpToRunner}
            onDiagnoseTrace={(traceId) => openDiagnoseTarget(createTraceDiagnoseTarget(traceId))}
            onDiagnoseExecution={(executionId, traceId) =>
              openDiagnoseTarget(createExecutionDiagnoseTarget(executionId, traceId))
            }
            onDiagnoseJob={(jobId, traceId) => openDiagnoseTarget(createJobDiagnoseTarget(jobId, traceId))}
            onDiagnoseRequest={(requestId, traceId) =>
              openDiagnoseTarget(createRequestDiagnoseTarget(requestId, traceId))
            }
          />
        )}
        {view === 'people' && (
          <AdminPeopleBoxesView
            query={query}
            runnerFilter={runnerFilter}
            onClearRunnerFilter={() => setRunnerFilter(null)}
            onOpenBox={openBox}
            onOpenOwnerGroup={(group) => openDiagnoseTarget(createOwnerGroupDiagnoseTarget(group))}
          />
        )}
        {view === 'fleet' && (
          <AdminFleetView
            query={query}
            highlightRunnerId={highlightRunner}
            onShowRunnerBoxes={showRunnerBoxes}
            onDiagnoseRunner={(runner) => openDiagnoseTarget(createRunnerDiagnoseTarget(runner))}
            onDiagnoseMachine={(machine) => openDiagnoseTarget(createMachineDiagnoseTarget(machine))}
          />
        )}
      </div>

      <AdminTelemetryDrawer
        target={diagnoseTarget}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onRecover={recoverBox}
        onCordonRunner={cordonRunner}
        onDrainRunner={drainRunner}
        onJumpToRunner={jumpToRunner}
      />
    </div>
  )
}

export default Admin
