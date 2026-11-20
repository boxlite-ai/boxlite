/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ascii'
import { AppTable } from '@/components/apps/AppTable'
import { CreateAppDialog } from '@/components/apps/CreateAppDialog'
import { RecentlyDeleted } from '@/components/apps/RecentlyDeleted'
import { OrganizationScope } from '@/components/apps/OrganizationScope'
import { deleteAppBody, toastDeleted } from '@/components/apps/deleteCopy'
import { SearchField } from '@/components/apps/spec'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Plus } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useAppMutation, useRestoreApp } from '@/hooks/mutations/useAppMutations'
import { useAppsQuery } from '@/hooks/queries/useAppsQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import type { AppSummary } from '@/lib/apps/types'
import { errorText, useAppsScope } from '@/lib/apps/client'
import { handleApiError } from '@/lib/error-handling'
import { useMemo, useState } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

// Same rule as Boxes: with a handful of apps the table already says what the cards would.
const FLEET_THRESHOLD = 10

const Apps: React.FC = () => {
  const { canWrite, canDelete } = useAppsScope()
  const { selectedOrganization } = useSelectedOrganization()
  const navigate = useNavigate()
  const { data: apps = [], isLoading, error, refetch } = useAppsQuery()
  const mutation = useAppMutation()
  const restore = useRestoreApp()
  const [filter, setFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const cannotCreate = !canWrite
    ? 'You need App write permission to create Apps.'
    : selectedOrganization?.suspended
      ? `${selectedOrganization.name} is suspended: ${selectedOrganization.suspensionReason}`
      : null
  const [toDelete, setToDelete] = useState<AppSummary | null>(null)

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return apps
    return apps.filter((app) => app.name.includes(needle) || (app.url ?? '').includes(needle))
  }, [apps, filter])

  const live = apps.filter((app) => app.status === 'live' || app.status === 'degraded').length
  const sleeping = apps.filter((app) => app.status === 'sleeping').length
  const attention = apps.filter((app) => app.status === 'failed').length

  return (
    <div className="resource-page flex-1">
      <header className="space-y-2">
        <h1 className="resource-title">App hosting</h1>
        <p className="text-body text-muted-foreground">Deploy and manage your apps on BoxLite.</p>
      </header>

      {apps.length >= FLEET_THRESHOLD && (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="total apps" value={String(apps.length)} sub="all states" />
          <StatCard label="live" value={String(live)} sub="serving" live={live > 0} />
          <StatCard
            label={attention > 0 ? 'need attention' : 'sleeping'}
            value={String(attention > 0 ? attention : sleeping)}
            sub={attention > 0 ? 'failed' : 'wake on request'}
          />
        </div>
      )}

      <div className="resource-toolbar">
        <SearchField value={filter} onChange={setFilter} placeholder="Filter apps…" count={visible.length} />
        <Button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={!!cannotCreate}
          title={cannotCreate ?? undefined}
        >
          <Plus className="size-3.5" aria-hidden="true" /> New app
        </Button>
      </div>
      {cannotCreate && <p className="-mt-3 text-right font-sans text-body text-muted-foreground">{cannotCreate}</p>}

      <AppTable
        apps={visible}
        filter={filter.trim() && apps.length > 0 ? filter.trim() : undefined}
        loading={isLoading}
        error={error ? errorText(error) : null}
        onRetry={() => refetch()}
        onRowClick={(app) => navigate(generatePath(RoutePath.APP_DETAILS, { appId: app.id }))}
        onDelete={canDelete ? setToDelete : undefined}
        onCreate={cannotCreate ? undefined : () => setCreateOpen(true)}
      />

      <RecentlyDeleted />

      <CreateAppDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(app) => {
          toast.success(`${app.name} is ready for your agent`)
          navigate(`${generatePath(RoutePath.APP_DETAILS, { appId: app.id })}?tab=overview`)
        }}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent className="font-sans">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild className="text-body">
              <div>{toDelete && deleteAppBody(toDelete.name)}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                const target = toDelete
                setToDelete(null)
                if (!target) return
                try {
                  await mutation.mutateAsync({ kind: 'delete', appId: target.id })
                  toastDeleted(target.name, (name) => restore.mutateAsync(name))
                } catch (error) {
                  handleApiError(error, 'Failed to delete app')
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default function AppsPage() {
  return (
    <OrganizationScope>
      <Apps />
    </OrganizationScope>
  )
}
