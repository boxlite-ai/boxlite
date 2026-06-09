/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
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
import { Input } from '@/components/ui/input'
import { RoutePath } from '@/enums/RoutePath'
import { cn } from '@/lib/utils'
import { Activity, Search, Server, UsersRound, type LucideIcon } from 'lucide-react'
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
    <PageLayout>
      <PageHeader size="full">
        <PageTitle>Admin</PageTitle>
      </PageHeader>

      <PageContent size="full">
        <AdminStatusStrip />

        {/* toolbar: view switch + global search */}
        <div className="mt-6 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <nav
            aria-label="Admin views"
            className="grid w-full gap-1 rounded-xl border border-border/80 bg-muted/60 p-1.5 shadow-sm xl:max-w-2xl xl:grid-cols-3"
          >
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
                    'relative flex min-h-12 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                      : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{v.label}</span>
                  {isActive && <span className="absolute inset-x-4 bottom-1 h-0.5 rounded-full bg-primary" />}
                </button>
              )
            })}
          </nav>

          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search users, boxes, runners…"
              className="pl-8"
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
      </PageContent>

      <AdminTelemetryDrawer
        target={diagnoseTarget}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onRecover={recoverBox}
        onCordonRunner={cordonRunner}
        onDrainRunner={drainRunner}
        onJumpToRunner={jumpToRunner}
      />
    </PageLayout>
  )
}

export default Admin
