/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
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
  Globe,
  LayoutDashboard,
  MoreVertical,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useAppMutation, useRestoreApp } from '@/hooks/mutations/useAppMutations'
import { useAppEnv, useAppQuery, useRefreshOnDeployDone } from '@/hooks/queries/useAppsQuery'
import { errorText, httpStatusOf, useAppsScope } from '@/lib/apps/client'
import { appStatusOf, capitalize, VISIBILITY_LABEL, VISIBILITY_ORDER } from '@/lib/apps/format'
import { useOpenApp } from '@/lib/apps/open'
import type { AppDetail, AppRelease, AppTab, AppVisibility } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { OrganizationScope } from './OrganizationScope'
import { DeployProgress } from './DeployProgress'
import { EnvironmentSwitcher } from './EnvironmentSwitcher'
import { useConfirm } from './confirm'
import { deleteAppBody, toastDeleted } from './deleteCopy'
import { StatusBadge } from './spec'
import { Tag } from './viz'
import { DatabaseTab } from './tabs/DatabaseTab'
import { AuthTab } from './tabs/AuthTab'
import { DeploymentsTab } from './tabs/DeploymentsTab'
import { DomainsTab } from './tabs/DomainsTab'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LogsTab } from './tabs/LogsTab'
import { OverviewTab } from './tabs/OverviewTab'
import { VariablesTab } from './tabs/VariablesTab'
import { VolumesTab } from './tabs/VolumesTab'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useQueryClient } from '@tanstack/react-query'

// Each tab carries the console's pixel glyph for what it holds, so the strip can be scanned by shape.
const TABS: { id: AppTab; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'deployments', label: 'Deployments', icon: CloudUpload },
  { id: 'domains', label: 'Domains', icon: Globe },
  { id: 'auth', label: 'Auth', icon: ShieldCheck },
  { id: 'database', label: 'Database', icon: Database },
  { id: 'volumes', label: 'Volumes', icon: Folder },
  { id: 'variables', label: 'Variables', icon: Braces },
  // Logs last: what the app is made of comes first; logs are where you go when something is off.
  { id: 'logs', label: 'Logs', icon: FileText },
]

function isTab(value: string | null): value is AppTab {
  return TABS.some((tab) => tab.id === value)
}

function AppDetails() {
  const { organizationId, canWrite } = useAppsScope()
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
  useRefreshOnDeployDone(app)
  const mutation = useAppMutation()
  const restoreApp = useRestoreApp()
  const [confirm, confirmElement] = useConfirm()
  // What the console asked for right now (restart, access), said in the header while it happens.
  const [inFlight, setInFlight] = useState<string | null>(null)
  const [restarting, setRestarting] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState<string | null>(null)
  const queryClient = useQueryClient()

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
    params.delete('deployment')
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
            Anyone with {app.url ?? "this environment's URL"} can open it without signing in
            {exposed ? ` (it serves ${exposed.name})` : ''}. Your agent&apos;s later deploys keep this setting until you
            change it here.
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

  // Deleting an app can be undone for 7 days (Recently deleted), so it asks once and offers Undo;
  // only an environment, which is removed for good, asks for its name.
  const deleteApp = async () => {
    if (!app) return
    const ok = await confirm({
      title: `Delete ${app.name}?`,
      body: deleteAppBody(app.name),
      confirmLabel: 'Delete app',
      danger: true,
    })
    if (!ok) return
    try {
      await mutation.mutateAsync({ kind: 'delete', appId: app.id })
      toastDeleted(app.name, canWrite ? (name) => restoreApp.mutateAsync(name) : undefined)
      queryClient.removeQueries({ queryKey: queryKeys.apps.detail(organizationId, app.id) })
      navigate(RoutePath.APPS)
    } catch (err) {
      handleApiError(err, 'Failed to delete')
    }
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
    const gone = app.environment
    if (
      await run(
        { kind: 'deleteEnvironment', appId: app.id, name: gone },
        `${gone} deleted`,
        'Failed to delete the environment',
      )
    ) {
      switchEnv('main')
      // Nothing may keep asking for what no longer exists (each refetch would be a 404).
      queryClient.removeQueries({ queryKey: queryKeys.apps.detail(organizationId, app.id, gone) })
    }
  }

  const isNotFound = isError && httpStatusOf(error) === 404

  return (
    <div className="resource-page min-w-0 flex-1 gap-4">
      <div className="flex items-center gap-[9px] font-sans text-meta text-muted-foreground">
        <button type="button" onClick={() => navigate(RoutePath.APPS)} className="hover:text-foreground">
          App hosting
        </button>
        <span className="text-border">/</span>
        <span className="text-foreground">{app?.name ?? appId}</span>
      </div>

      {isNotFound ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center font-sans text-muted-foreground">
          <Container className="size-8" strokeWidth={1.3} />
          <div className="text-foreground">{env === 'main' ? 'App not found' : `No environment named ${env}`}</div>
          <button
            type="button"
            onClick={() => navigate(RoutePath.APPS)}
            className="mt-2 border border-border px-4 py-2 text-body hover:bg-card"
          >
            Back to App hosting
          </button>
        </div>
      ) : isError && !app ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center font-sans">
          <div className="text-body font-semibold text-foreground">The app could not be loaded</div>
          <div className="max-w-lg text-meta text-muted-foreground">{errorText(error)}</div>
          <button
            type="button"
            onClick={() => refetch()}
            className="mt-2 border border-border px-4 py-2 text-body hover:bg-card focus-visible:ring-2 focus-visible:ring-brand/35"
          >
            Retry
          </button>
        </div>
      ) : isLoading || !app ? (
        <div className="flex flex-1 items-center justify-center gap-2 font-sans text-muted-foreground">
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
                // A schedule is a request too: it wakes the app when it is due.
                app.schedules.length
                  ? `${app.environment} is asleep until the next visit or its next scheduled job`
                  : `${app.environment} is asleep`,
                'Failed to sleep',
                'Going to sleep…',
              )
            }
            onDelete={deleteApp}
            onDeleteEnvironment={deleteEnvironment}
            inFlight={inFlight}
            onRefresh={() => refetch()}
            environment={
              <EnvironmentSwitcher
                appId={app.id}
                appName={app.name}
                current={env}
                onSwitch={switchEnv}
                onDelete={deleteEnvironment}
              />
            }
            // Each tab has its own primary action; Open app leads only on Overview.
          />

          {/* Content tabs share the Console underline navigation. */}
          <Tabs value={tab} onValueChange={(next) => goTo(next as AppTab)} className="gap-0">
            <TabsList variant="underline" className="max-w-full overflow-x-auto overflow-y-hidden">
              {TABS.map((candidate) => (
                <TabsTrigger
                  key={candidate.id}
                  value={candidate.id}
                  className="font-sans"
                  // The tab already open goes back to its top level (from a deployment, to the list).
                  onClick={() => candidate.id === tab && goTo(tab)}
                >
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
              onOpenDeployment={(n) => goTo('deployments', undefined, { deployment: String(n) })}
              onSwitchEnv={switchEnv}
            />
          )}
          {tab === 'deployments' && (
            <DeploymentsTab
              app={app}
              section={sectionParam}
              onSection={(next) => goTo('deployments', next === 'history' ? undefined : next)}
              restarting={restarting}
              onRestartService={restartService}
              onRollback={rollback}
              rollingBack={rollingBack}
              selected={Number(searchParams.get('deployment')) || null}
              onSelect={(n) => goTo('deployments', undefined, n ? { deployment: String(n) } : {})}
              onOpenLogs={(n) => goTo('logs', 'runtime', { deployment: String(n) })}
            />
          )}
          {tab === 'logs' && (
            <LogsTab
              app={app}
              section={section}
              source={searchParams.get('source') ?? undefined}
              deployment={Number(searchParams.get('deployment')) || null}
              onSection={(next) => goTo('logs', next)}
              onDeployment={(n) => goTo('logs', 'runtime', n ? { deployment: String(n) } : {})}
              onOpenDeployment={(n) => goTo('deployments', undefined, { deployment: String(n) })}
              onGoTo={goTo}
            />
          )}
          {tab === 'auth' && <AuthTab app={app} />}
          {tab === 'database' && (
            <DatabaseTab
              app={app}
              section={section}
              onSection={(next) => goTo('database', next)}
              onOpenDeployment={(n) => goTo('deployments', undefined, { deployment: String(n) })}
            />
          )}
          {tab === 'domains' && <DomainsTab app={app} />}
          {tab === 'volumes' && <VolumesTab app={app} />}
          {tab === 'variables' && <VariablesTab app={app} />}

          {confirmElement}
        </>
      )}
    </div>
  )
}

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
  /** What the console asked for right now (restarting, changing access…), shown next to the status. */
  inFlight: string | null
}) {
  const openApp = useOpenApp()
  const { canWrite, canDelete } = useAppsScope()
  // While a new deployment runs, the live one keeps serving: the status names what serves users,
  // and the progress line beside it names what is on its way.
  const runtime = appStatusOf(app.status === 'building' && app.activeRelease ? 'live' : app.status)
  const latest = app.releases[0]
  const failedNewer = latest && latest.status === 'failed' && app.activeRelease ? latest : null
  return (
    // Keep identity and controls together; the content tabs supply the divider below.
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="resource-title break-all">{app.name}</h1>
        <span className="font-sans text-em text-border">/</span>
        {environment}
        {/* Before the first release the progress line says it all. */}
        {(app.activeRelease || !app.deploying) && (
          <StatusBadge className="ml-1" color={runtime.color} label={runtime.label} />
        )}
        {app.deploying && <DeployProgress deploying={app.deploying} />}
        {inFlight && (
          <span className="inline-flex items-center gap-2 font-sans text-meta text-warning">
            <Spinner className="size-3.5" />
            {inFlight}
          </span>
        )}
        {failedNewer && !app.deploying && <Tag tone="bad">{failedNewer.id} failed</Tag>}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <AccessMenu app={app} busy={busy} onPublish={onPublish} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" aria-label="More" variant="outline" size="icon">
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[15rem] font-sans">
            <div className="px-2 py-1.5 text-meta text-muted-foreground">Environment · {app.environment}</div>
            {/* Nothing runs before the first release, so there is nothing to restart or sleep. */}
            {/* Asleep, there is nothing to restart or put to sleep; the next request wakes it. */}
            {app.activeRelease && app.status !== 'sleeping' && app.box && (
              <>
                {app.services.length > 0 && (
                  <DropdownMenuItem disabled={!canWrite} className="cursor-pointer" onClick={onRestart}>
                    Restart services
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!canWrite} className="cursor-pointer" onClick={onSleep}>
                  Sleep now
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem className="cursor-pointer" onClick={onRefresh}>
              Refresh
            </DropdownMenuItem>
            {app.environment !== 'main' && (
              <DropdownMenuItem
                className="cursor-pointer text-destructive focus:text-destructive"
                disabled={!canWrite}
                onClick={onDeleteEnvironment}
              >
                Delete environment {app.environment}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-meta text-muted-foreground">App · {app.name}</div>
            <DropdownMenuItem
              disabled={!canDelete}
              className="cursor-pointer text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              Delete app
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Only a live release can be opened; before that the URL answers "nothing deployed". */}
        {app.url && app.activeRelease && (
          <Button
            type="button"
            onClick={() => void openApp(app.id, app.environment)}
            // The same primary button on every tab: opening the app is always one click.
          >
            Open app <ArrowUpRight className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

/** Who can open the app, each level with what it means. */
const ACCESS_REASON: Record<AppVisibility, string> = {
  private: 'You and anyone signed in to this console',
  org: 'Members of your BoxLite organization, signed in',
  public: 'Anyone with the URL; pages behind sign-in still ask for it',
}

function AccessMenu({
  app,
  busy,
  onPublish,
}: {
  app: AppDetail
  busy: boolean
  onPublish: (visibility: AppVisibility) => void
}) {
  const { canWrite } = useAppsScope()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" disabled={busy || !canWrite}>
          Access: <span className="text-foreground">{capitalize(VISIBILITY_LABEL[app.visibility])}</span>
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[20rem] font-sans">
        <div className="px-2 py-1.5 text-meta text-muted-foreground">
          Who can open {app.environment}
          {app.accessSource === 'online' ? ' · set here' : ' · as your agent set it'}
        </div>
        {VISIBILITY_ORDER.map((visibility) => (
          <DropdownMenuItem
            key={visibility}
            className="cursor-pointer items-start justify-between gap-3"
            onClick={() => visibility !== app.visibility && onPublish(visibility)}
          >
            <span className="flex flex-col gap-0.5">
              <span>{capitalize(VISIBILITY_LABEL[visibility])}</span>
              <span className="text-meta text-muted-foreground">{ACCESS_REASON[visibility]}</span>
            </span>
            {visibility === app.visibility && <Check className="mt-0.5 size-4 shrink-0" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function AppDetailsPage() {
  return (
    <OrganizationScope>
      <AppDetails />
    </OrganizationScope>
  )
}
