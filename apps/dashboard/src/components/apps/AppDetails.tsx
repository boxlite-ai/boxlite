/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
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
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { useAppEnv, useAppQuery } from '@/hooks/queries/useAppsQuery'
import { appStatusOf, capitalize, VISIBILITY_LABEL, VISIBILITY_ORDER } from '@/lib/apps/format'
import type { AppDetail, AppRelease, AppTab, AppVisibility } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { isAxiosError } from 'axios'
import { useState, type ReactNode } from 'react'
import { Link, generatePath, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { EnvironmentSwitcher } from './EnvironmentSwitcher'
import { useConfirm } from './confirm'
import { FlatButton, StatusBadge, DIALOG_FRAME } from './spec'
import { Tag } from './viz'
import { DatabaseTab } from './tabs/DatabaseTab'
import { DomainsTab } from './tabs/DomainsTab'
import { DeploymentsTab } from './tabs/DeploymentsTab'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PendingChanges } from './PendingChanges'
import { LogsTab } from './tabs/LogsTab'
import { OverviewTab } from './tabs/OverviewTab'
import { UsersTab } from './tabs/UsersTab'
import { VariablesTab } from './tabs/VariablesTab'
import { VolumesTab } from './tabs/VolumesTab'

// Each tab carries the console's pixel glyph for what it holds, so the strip can be scanned by shape.
const TABS: { id: AppTab; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'deployments', label: 'Deployments', icon: CloudUpload },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'domains', label: 'Domains', icon: Globe },
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
  const [renameOpen, setRenameOpen] = useState(false)
  const [confirm, confirmElement] = useConfirm()
  // What the environment is doing right now, said in the header while it happens.
  const [inFlight, setInFlight] = useState<string | null>(null)
  const [restarting, setRestarting] = useState<string | null>(null)
  const [rollingBack, setRollingBack] = useState<string | null>(null)
  const [deploying, setDeploying] = useState(false)
  // The deployment being created right now, listed on Deployments before it finishes.
  const [building, setBuilding] = useState<{ id: string; stage: string; summary: string } | null>(null)

  const env = useAppEnv()
  // Switching environment keeps the tab; the screen inside it starts fresh.
  const switchEnv = (next: string) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'production') params.delete('env')
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
      const ports =
        app.services
          .filter((s) => s.port)
          .map((s) => `${s.name} :${s.port}`)
          .join(', ') || 'none yet'
      const ok = await confirm({
        title: `Open ${app.name} · ${app.environment} to anyone?`,
        body: (
          <>
            Only the published service port goes public ({ports}). The workspace, terminal and private ports stay
            private, and visitors no longer have to sign in.
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
    // Migrations that ran after the deployment being rolled back to: its code predates them.
    const later = (app.database?.migrations ?? []).filter((m) => new Date(m.at) > new Date(target.createdAt))
    const ok = await confirm({
      title: `Roll back ${app.environment} to ${target.id}?`,
      body: (
        <span className="flex flex-col gap-2">
          <span>
            {target.id} &ldquo;{target.summary ?? 'deployment'}&rdquo; goes live again and{' '}
            {app.services.map((s) => s.name).join(', ') || 'the services'} restart. Only the code changes: variables
            keep their live values, and database rows and files stay as they are (to restore data, use a backup in
            Database).
          </span>
          {(app.pendingChanges?.length ?? 0) > 0 && (
            <span>
              Your {app.pendingChanges?.length} saved variable{' '}
              {app.pendingChanges?.length === 1 ? 'change stays' : 'changes stay'} pending.
            </span>
          )}
          {later.length > 0 && (
            <span className="text-warning">
              {later.map((m) => m.file).join(', ')} ran after {target.id}. Its code may not match the current schema.
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
      `${app.environment} is back on ${target.id}`,
      'Rollback failed',
      `Rolling back to ${target.id}…`,
    )
    setRollingBack(null)
  }

  const deployChanges = async () => {
    if (!app?.pendingChanges?.length || deploying) return
    const next = `#${Math.max(0, ...app.releases.map((r) => Number(r.id.slice(1)) || 0)) + 1}`
    // Say which step the deployment is on, so a slow one is diagnosable while it runs.
    const stages = ['building', 'starting services', 'waiting for health check']
    const count = app.pendingChanges.length
    const summary = `Apply ${count} variable ${count === 1 ? 'change' : 'changes'}`
    const started = Date.now()
    const tick = () => {
      const ms = Date.now() - started
      const index = Math.min(stages.length - 1, Math.floor(ms / 600))
      const stage = `${index + 1}/${stages.length} ${stages[index]}`
      setInFlight(`Deploying ${next} · ${stage} · ${Math.floor(ms / 1000)}s`)
      setBuilding({ id: next, stage, summary })
    }
    // The edit toasts' Undo would now be ambiguous (this deployment or the next?), so they go.
    toast.dismiss()
    setDeploying(true)
    tick()
    const timer = window.setInterval(tick, 300)
    try {
      await mutation.mutateAsync({ kind: 'action', appId: app.id, action: { type: 'deployChanges' } })
      toast.success(`${next} is live in ${app.environment}`, {
        action: { label: 'View', onClick: () => goTo('deployments') },
      })
    } catch (err) {
      // The changes stay pending, so Deploy changes is the retry.
      handleApiError(err, `${next} did not go live; your changes are still pending`)
    } finally {
      window.clearInterval(timer)
      setInFlight(null)
      setBuilding(null)
      setDeploying(false)
    }
  }

  // Rollback swaps code only; a deployment that changed variables is undone by staging the inverse.
  const revertVariables = async (release: AppRelease) => {
    if (!app || !release.envChanges) return
    const inverse = release.envChanges.filter((c) => !c.secret)
    const skipped = release.envChanges.length - inverse.length
    const ok = await confirm({
      title: `Revert the variable changes of ${release.id}?`,
      body: (
        <span className="flex flex-col gap-2">
          <span>These are saved as pending changes; nothing reaches the app until you deploy them.</span>
          <span className="flex flex-col text-foreground">
            {inverse.map((c) => (
              <span key={c.name}>
                {c.change === 'added' ? `remove ${c.name}` : `set ${c.name} back to ${c.live ?? '(empty)'}`}
              </span>
            ))}
          </span>
          {skipped > 0 && <span>Secret references are left as they are; change them in Variables.</span>}
        </span>
      ),
      confirmLabel: `Stage ${inverse.length} ${inverse.length === 1 ? 'change' : 'changes'}`,
    })
    if (!ok) return
    try {
      for (const c of inverse) {
        await mutation.mutateAsync({
          kind: 'action',
          appId: app.id,
          action:
            c.change === 'added'
              ? { type: 'removeVariable', name: c.name }
              : { type: 'setVariable', name: c.name, value: c.live ?? '' },
        })
      }
      toast.success(`Staged the reverse of ${release.id}; deploy to apply`)
    } catch (err) {
      handleApiError(err, 'Could not stage the revert')
    }
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
          Every environment goes now: their boxes, URLs, users and domains. Databases and volumes are kept; delete them
          from their own pages if you want them gone.
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
      body: <>Its box, database, users, files and domains go now. Other environments are not touched.</>,
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
      switchEnv('production')
  }

  const isNotFound = isError && isAxiosError(error) && error.response?.status === 404

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
          <div className="text-foreground">
            {env === 'production' ? 'App not found' : `No environment named ${env}`}
          </div>
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
              run({ kind: 'restart', appId: app.id }, 'Services restarted', 'Failed to restart', 'Restarting services…')
            }
            onSleep={() =>
              run(
                { kind: 'sleep', appId: app.id },
                `${app.environment} is asleep`,
                'Failed to sleep',
                'Going to sleep…',
              )
            }
            onRebuild={() =>
              run(
                { kind: 'rebuild', appId: app.id },
                'Rebuilding from the current deployment',
                'Failed to rebuild',
                'Rebuilding…',
              )
            }
            onDelete={deleteApp}
            onDeleteEnvironment={deleteEnvironment}
            inFlight={inFlight}
            onRename={() => setRenameOpen(true)}
            onRefresh={() => refetch()}
            environment={<EnvironmentSwitcher appId={app.id} appName={app.name} current={env} onSwitch={switchEnv} />}
            // Each tab has its own primary action; Open app leads only on Overview.
            primaryOpen={tab === 'overview'}
          />

          <PendingChanges
            app={app}
            deploying={building}
            onReview={tab === 'variables' ? undefined : () => goTo('variables')}
            onDeploy={() => void deployChanges()}
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
          {tab === 'deployments' && (
            <DeploymentsTab
              app={app}
              onRollback={rollback}
              onRevertVariables={revertVariables}
              rollingBack={rollingBack}
              building={building}
            />
          )}
          {tab === 'logs' && (
            <LogsTab
              app={app}
              section={section}
              source={searchParams.get('source') ?? undefined}
              onSection={(next) => goTo('logs', next)}
            />
          )}
          {tab === 'domains' && <DomainsTab app={app} />}
          {tab === 'auth' && (
            <UsersTab
              app={app}
              section={section}
              onSection={(next) => goTo('auth', next)}
              onOpenLogs={() => goTo('logs', 'runtime', { source: 'auth' })}
            />
          )}
          {tab === 'database' && (
            <DatabaseTab app={app} section={section} onSection={(next) => goTo('database', next)} />
          )}
          {tab === 'volumes' && <VolumesTab app={app} />}
          {tab === 'variables' && <VariablesTab app={app} />}

          {confirmElement}

          {renameOpen && (
            <RenameDialog
              current={app.name}
              busy={mutation.isPending}
              onClose={() => setRenameOpen(false)}
              onSave={async (name) => {
                await run({ kind: 'rename', appId: app.id, name }, `Renamed to ${name}`, 'Failed to rename')
                setRenameOpen(false)
              }}
            />
          )}
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
  onRebuild,
  onDelete,
  onDeleteEnvironment,
  onRename,
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
  onRebuild: () => void
  onDelete: () => void
  onDeleteEnvironment: () => void
  onRename: () => void
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
  const failedNewer = latest && latest.status === 'failed' && latest.id !== app.activeRelease ? latest : null
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
        {failedNewer && <Tag tone="bad">{failedNewer.id} failed to build</Tag>}
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
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">Who can open the app</div>
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
                <DropdownMenuItem className="cursor-pointer" onClick={onSleep} disabled={app.status === 'sleeping'}>
                  Sleep now
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="cursor-pointer">
                  <Link to={generatePath(RoutePath.BOX_DETAILS, { boxId: app.workspace.boxId })}>
                    Open box {app.workspace.boxName}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem className="cursor-pointer" onClick={onRebuild}>
                  Rebuild box from current deployment
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem className="cursor-pointer" onClick={onRefresh}>
              Refresh
            </DropdownMenuItem>
            {app.environment !== 'production' && (
              <DropdownMenuItem
                className="cursor-pointer text-destructive focus:text-destructive"
                onClick={onDeleteEnvironment}
              >
                Delete {app.environment}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <div className="px-2 py-1.5 text-[12px] text-muted-foreground">App · {app.name}</div>
            <DropdownMenuItem className="cursor-pointer" onClick={onRename}>
              Rename app
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer text-destructive focus:text-destructive" onClick={onDelete}>
              Delete app
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {app.url ? (
          <a
            href={app.url}
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

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/** Rename keeps the app id and the URL; the URL's slug is changed in Domains. */
function RenameDialog({
  current,
  busy,
  onClose,
  onSave,
}: {
  current: string
  busy: boolean
  onClose: () => void
  onSave: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(current)
  const error = name && !NAME_RE.test(name) ? 'Use lowercase letters, digits and dashes.' : null
  const blocked = busy || !name || !!error || name === current
  const save = () => {
    if (!blocked) void onSave(name)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={cn(DIALOG_FRAME, 'max-w-[460px] font-mono text-body')}>
        <DialogHeader>
          <DialogTitle className="font-mono text-[18px] font-bold tracking-[-0.3px]">Rename {current}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            aria-invalid={!!error}
            className="font-mono"
          />
          <span className={cn('text-[12px]', error ? 'text-destructive' : 'text-muted-foreground')}>
            {error ?? 'The URL stays the same; its slug is set in Domains.'}
          </span>
        </div>
        <DialogFooter className="gap-2">
          <FlatButton onClick={onClose}>Cancel</FlatButton>
          <FlatButton variant="primary" disabled={blocked} onClick={save}>
            Rename
          </FlatButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
