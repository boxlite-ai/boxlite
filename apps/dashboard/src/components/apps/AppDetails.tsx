/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import {
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  CloudUpload,
  Container,
  Database,
  FileText,
  Folder,
  LayoutDashboard,
  MoreVertical,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { useAppEnv, useAppQuery } from '@/hooks/queries/useAppsQuery'
import { httpStatusOf } from '@/lib/apps/client'
import { appStatusOf, capitalize, VISIBILITY_LABEL, VISIBILITY_ORDER } from '@/lib/apps/format'
import type { AppDetail, AppRelease, AppTab, AppVisibility } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { EnvironmentSwitcher } from './EnvironmentSwitcher'
import { useConfirm } from './confirm'
import { StatusBadge } from './spec'
import { Tag } from './viz'
import { DatabaseTab } from './tabs/DatabaseTab'
import { AuthTab } from './tabs/AuthTab'
import { DeploymentsTab } from './tabs/DeploymentsTab'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LogsTab } from './tabs/LogsTab'
import { OverviewTab } from './tabs/OverviewTab'
import { VariablesTab } from './tabs/VariablesTab'
import { VolumesTab } from './tabs/VolumesTab'

// Each tab carries the console's pixel glyph for what it holds, so the strip can be scanned by shape.
// Domains is not offered: the control plane serves <cp>/<app>/ only.
const TABS: { id: AppTab; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'deployments', label: 'Deployments', icon: CloudUpload },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'auth', label: 'Auth', icon: ShieldCheck },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'volumes', label: 'Volumes', icon: Folder },
  { id: 'variables', label: 'Variables', icon: Braces },
]

function isTab(value: string | null): value is AppTab {
  return TABS.some((tab) => tab.id === value)
}

export default function AppDetails() {
  const { appId = '' } = useParams<{ appId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const sectionParam = searchParams.get('section') ?? undefined
  // Old links: Data held both; its storage screen is now the Volumes tab.
  const rawTab = searchParams.get('tab') === 'settings' ? 'variables' : searchParams.get('tab')
  const tabParam =
    rawTab === 'data' ? (sectionParam === 'storage' || sectionParam === 'volumes' ? 'volumes' : 'database') : rawTab
  const tab: AppTab = isTab(tabParam) ? tabParam : 'overview'
  const section = sectionParam === 'database' ? 'connection' : sectionParam

  const { data: app, isLoading, isError, error, refetch, isFetching } = useAppQuery(appId)
  const mutation = useAppMutation()
  const [confirm, confirmElement] = useConfirm()
  // What the console asked for right now (restart, access), said in the header while it happens.
  const [inFlight, setInFlight] = useState<string | null>(null)
  const [restarting, setRestarting] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState<string | null>(null)

  const env = useAppEnv()
  // Switching environment keeps the tab; the screen inside it starts fresh.
  const switchEnv = (next: string) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'main') params.delete('env')
    else params.set('env', next)
    params.delete('section')
    setSearchParams(params)
  }

  const goTo = (next: AppTab, nextSection?: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams(searchParams)
    params.set('tab', next)
    if (nextSection) params.set('section', nextSection)
    else params.delete('section')
    params.delete('source')
    for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value)
    setSearchParams(params)
  }

  const run = async (
    action: Parameters<typeof mutation.mutateAsync>[0],
    success: string,
    failure: string,
    progress?: string,
  ): Promise<boolean> => {
    if (progress) setInFlight(progress)
    try {
      await mutation.mutateAsync(action)
      toast.success(success)
      return true
    } catch (err) {
      handleApiError(err, failure)
      return false
    } finally {
      if (progress) setInFlight(null)
    }
  }

  const publish = async (visibility: AppVisibility) => {
    if (!app) return
    if (visibility === 'public') {
      const exposed = app.services.find((s) => s.exposed)
      const ok = await confirm({
        title: `Open ${app.name} · ${app.environment} to anyone?`,
        body: (
          <>
            Anyone with {app.url} can open it without signing in{exposed ? ` (it serves ${exposed.name})` : ''}. The
            setting wins over access in boxlite.toml until you change it here again.
          </>
        ),
        confirmLabel: 'Make public',
      })
      if (!ok) return
    }
    void run(
      { kind: 'publish', appId: app.id, visibility },
      `${app.environment} is open to ${VISIBILITY_LABEL[visibility]}`,
      'Failed to change access',
      'Changing access…',
    )
  }

  const rollback = async (target: AppRelease) => {
    if (!app) return
    // Deployments after the target that ran migrations: its code predates their schema.
    const later = app.releases.filter((r) => r.number > target.number && r.restorePoint)
    const ok = await confirm({
      title: `Roll back ${app.environment} to ${target.id}?`,
      body: (
        <span className="flex flex-col gap-2">
          <span>
            A new deployment puts {target.id} &ldquo;{target.summary}&rdquo; back live: its code and its configuration
            (variables, services). The database and volumes stay as they are.
          </span>
          {later.length > 0 && (
            <span className="text-warning">
              {later.map((r) => r.id).join(', ')} ran migrations after {target.id}. Its code may not match the current
              schema.
            </span>
          )}
        </span>
      ),
      confirmLabel: `Roll back to ${target.id}`,
    })
    if (!ok) return
    setRollingBack(target.id)
    await run(
      { kind: 'activate', appId: app.id, releaseId: target.id },
      `Rolling back ${app.environment} to ${target.id}`,
      'Rollback failed',
      `Starting a rollback to ${target.id}…`,
    )
    setRollingBack(null)
  }

  const restartService = async (service: string) => {
    if (!app) return
    setRestarting(service)
    await run({ kind: 'restart', appId: app.id, service }, `${service} restarted`, 'Failed to restart')
    setRestarting(null)
  }

  const deleteApp = async () => {
    if (!app) return
    const ok = await confirm({
      title: `Delete ${app.name}?`,
      body: (
        <>
          Every environment goes now: its Box, URL, database, volumes, deployments and logs. The App key stops working.
          This cannot be undone.
        </>
      ),
      confirmLabel: 'Delete app',
      danger: true,
      typeToConfirm: app.name,
    })
    if (!ok) return
    if (await run({ kind: 'delete', appId: app.id }, `${app.name} deleted`, 'Failed to delete'))
      navigate(RoutePath.APPS)
  }

  const deleteEnvironment = async () => {
    if (!app) return
    const ok = await confirm({
      title: `Delete ${app.environment}?`,
      body: <>Its Box, database branch, volumes and URL go now. Other environments are not touched.</>,
      confirmLabel: `Delete ${app.environment}`,
      danger: true,
      typeToConfirm: app.environment,
    })
    if (!ok) return
    if (
      await run(
        { kind: 'deleteEnvironment', appId: app.id, name: app.environment },
        `${app.environment} deleted`,
        'Failed to delete the environment',
      )
    )
      switchEnv('main')
  }

  const isNotFound = isError && httpStatusOf(error) === 404

  return (
    <div className="flex min-h-[calc(100svh-60px)] w-full flex-col px-4 pb-10 pt-4 sm:px-6 lg:px-[40px]">
      <div className="flex items-center gap-[9px] font-mono text-[12px] text-muted-foreground">
        <button type="button" onClick={() => navigate(RoutePath.APPS)} className="hover:text-foreground">
          apps
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{app?.name ?? appId}</span>
      </div>

      {isNotFound ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center font-mono text-muted-foreground">
          <Container className="size-8" strokeWidth={1.3} />
          <div className="text-foreground">{env === 'main' ? 'App not found' : `No environment named ${env}`}</div>
          <button
            type="button"
            onClick={() => navigate(RoutePath.APPS)}
            className="mt-2 border border-border px-4 py-2 text-[13px] hover:bg-card"
          >
            Back to Apps
          </button>
        </div>
      ) : isLoading || !app ? (
        <div className="flex flex-1 items-center justify-center gap-2 font-mono text-muted-foreground">
          <RefreshCw className="size-4 animate-spin" /> Loading app…
        </div>
      ) : (
        <>
          <Header
            app={app}
            busy={mutation.isPending || isFetching}
            onPublish={publish}
            onRestart={() =>
              run({ kind: 'restart', appId: app.id }, 'Restart requested', 'Failed to restart', 'Restarting services…')
            }
            onSleep={() =>
              run(
                { kind: 'sleep', appId: app.id },
                `${app.environment} is asleep`,
                'Failed to sleep',
                'Going to sleep…',
              )
            }
            onDelete={deleteApp}
            onDeleteEnvironment={deleteEnvironment}
            // A deployment in progress (any author: agent, console) is said here with its step.
            inFlight={inFlight ?? (app.status === 'building' ? app.statusDetail : null)}
            onRefresh={() => refetch()}
            environment={<EnvironmentSwitcher appId={app.id} appName={app.name} current={env} onSwitch={switchEnv} />}
            // Each tab has its own primary action; Open app leads only on Overview.
            primaryOpen={tab === 'overview'}
          />

          {/* The console's segmented tabs (as on Billing and Images). */}
          <Tabs value={tab} onValueChange={(next) => goTo(next as AppTab)} className="mb-7 gap-0">
            <TabsList variant="segmented" className="max-w-full overflow-x-auto">
              {TABS.map((candidate) => (
                <TabsTrigger key={candidate.id} value={candidate.id} className="font-mono">
                  <candidate.icon className="size-4 shrink-0" aria-hidden />
                  {candidate.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {tab === 'overview' && (
            <OverviewTab
              app={app}
              onGoTo={goTo}
              onRollback={rollback}
              onRestartService={restartService}
              restarting={restarting}
            />
          )}
          {tab === 'deployments' && <DeploymentsTab app={app} onRollback={rollback} rollingBack={rollingBack} />}
          {tab === 'logs' && (
            <LogsTab
              app={app}
              section={section}
              source={searchParams.get('source') ?? undefined}
              onSection={(next) => goTo('logs', next)}
            />
          )}
          {tab === 'auth' && <AuthTab app={app} />}
          {tab === 'database' && (
            <DatabaseTab app={app} section={section} onSection={(next) => goTo('database', next)} />
          )}
          {tab === 'volumes' && <VolumesTab app={app} />}
          {tab === 'variables' && <VariablesTab app={app} />}

          {confirmElement}
        </>
      )}
    </div>
  )
}

// The bordered control used in the box details header (stop, ⋮, refresh).
const HEADER_BUTTON =
  'inline-flex h-[34px] items-center gap-2 border border-border px-[15px] font-mono text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-background focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/35 disabled:opacity-50 data-[state=open]:bg-background'

function Header({
  app,
  busy,
  onPublish,
  onRestart,
  onSleep,
  onDelete,
  onDeleteEnvironment,
  onRefresh,
  environment,
  primaryOpen,
  inFlight,
}: {
  app: AppDetail
  busy: boolean
  onPublish: (visibility: AppVisibility) => void
  onRestart: () => void
  onSleep: () => void
  onDelete: () => void
  onDeleteEnvironment: () => void
  onRefresh: () => void
  environment: ReactNode
  primaryOpen: boolean
  /** What the environment is doing right now (restarting, rolling back…), shown in place of its status. */
  inFlight: string | null
}) {
  const runtime = appStatusOf(app.status)
  // The header says which deployment runs and how the runtime is doing, as two facts.
  // A newer deployment that failed is said separately: the old one is still serving.
  const latest = app.releases[0]
  const failedNewer = latest && latest.status === 'failed' && app.activeRelease ? latest : null
  return (
    // Laid out like box details: name, status, then bordered controls on the right, a dashed rule under it all.
    <div className="mb-5 mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-dashed border-border pb-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="font-display text-section font-semibold text-foreground">{app.name}</h1>
        <span className="font-mono text-em text-border">/</span>
        {environment}
        {/* What serves users stays visible while something is in progress next to it. */}
        <StatusBadge
          className="ml-1"
          color={runtime.color}
          label={app.activeRelease ? `${app.activeRelease} · ${runtime.label}` : runtime.label}
        />
        {inFlight && (
          <span className="inline-flex items-center gap-2 font-mono text-meta text-warning">
            <Spinner className="size-3.5" />
            {inFlight}
          </span>
        )}
        {failedNewer && <Tag tone="bad">{failedNewer.id} failed</Tag>}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" disabled={busy} className={cn(HEADER_BUTTON, 'text-muted-foreground')}>
              Access: <span className="text-foreground">{capitalize(VISIBILITY_LABEL[app.visibility])}</span>
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[16rem] font-mono">
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
              Who can open the app
              {app.accessSource === 'online' ? ' · set here, wins over boxlite.toml' : ' · from boxlite.toml'}
            </div>
            {VISIBILITY_ORDER.map((visibility) => (
              <DropdownMenuItem
                key={visibility}
                className="cursor-pointer justify-between"
                onClick={() => onPublish(visibility)}
              >
                <span>{capitalize(VISIBILITY_LABEL[visibility])}</span>
                {visibility === app.visibility && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="More" className={cn(HEADER_BUTTON, 'w-[34px] justify-center px-0')}>
              <MoreVertical className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[15rem] font-mono">
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">Environment · {app.environment}</div>
            {/* Nothing runs before the first deploy, so there is nothing to restart, sleep, open or rebuild. */}
            {app.status !== 'draft' && (
              <>
                <DropdownMenuItem className="cursor-pointer" onClick={onRestart} disabled={app.services.length === 0}>
                  Restart services
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer"
                  onClick={onSleep}
                  disabled={app.status === 'sleeping' || !app.box}
                >
                  Sleep now
                </DropdownMenuItem>
                {app.box && (
                  <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                    Box {app.box.id} · {app.box.state}
                  </div>
                )}
              </>
            )}
            <DropdownMenuItem className="cursor-pointer" onClick={onRefresh}>
              Refresh
            </DropdownMenuItem>
            {app.environment !== 'main' && (
              <DropdownMenuItem
                className="cursor-pointer text-destructive focus:text-destructive"
                onClick={onDeleteEnvironment}
              >
                Delete {app.environment}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">App · {app.name}</div>
            <DropdownMenuItem className="cursor-pointer text-destructive focus:text-destructive" onClick={onDelete}>
              Delete app
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {app.status !== 'draft' ? (
          <a
            href={app.openUrl}
            target="_blank"
            rel="noreferrer"
            className={cn(
              // A failed app has nothing worth opening, and other tabs have their own primary action.
              app.status === 'failed' || !primaryOpen
                ? HEADER_BUTTON
                : 'inline-flex h-[34px] items-center gap-2 bg-primary px-[15px] font-mono text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85',
            )}
          >
            Open app <ArrowUpRight className="size-3.5" />
          </a>
        ) : null}
      </div>
    </div>
  )
}
