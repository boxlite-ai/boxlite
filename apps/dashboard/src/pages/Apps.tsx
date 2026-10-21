/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { StatCard } from '@/components/ascii'
import { AppTable } from '@/components/apps/AppTable'
import { CreateAppDialog } from '@/components/apps/CreateAppDialog'
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
import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import { useAppsQuery } from '@/hooks/queries/useAppsQuery'
import type { AppSummary } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useMemo, useState } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

// Same rule as Boxes: with a handful of apps the table already says what the cards would.
const FLEET_THRESHOLD = 10

const Apps: React.FC = () => {
  const navigate = useNavigate()
  const { data: apps = [], isLoading } = useAppsQuery()
  const mutation = useAppMutation()
  const [filter, setFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
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
    <div className="flex min-h-[calc(100svh-60px)] flex-col gap-[22px] px-4 pb-[22px] pt-7 sm:px-6 lg:px-[40px]">
      <h1 className="font-display text-page font-semibold text-foreground">Apps</h1>

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

      <div className="flex items-center justify-between gap-3">
        <SearchField value={filter} onChange={setFilter} placeholder="Filter apps…" count={visible.length} />
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="inline-flex h-9 items-center justify-center gap-[7px] bg-primary px-[15px] text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-85"
        >
          <Plus className="size-3.5" strokeWidth={2.4} /> New App
        </button>
      </div>

      <AppTable
        apps={visible}
        loading={isLoading}
        onRowClick={(app) => navigate(generatePath(RoutePath.APP_DETAILS, { appId: app.id }))}
        onDelete={setToDelete}
        onCreate={() => setCreateOpen(true)}
      />

      <CreateAppDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onOpen={(app) => navigate(`${generatePath(RoutePath.APP_DETAILS, { appId: app.id })}?tab=overview`)}
      />

      <AlertDialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent className="font-mono">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {toDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription className="text-[12px]">
              Every environment goes now: its Box, URL, database, volumes, deployments and logs. The App key stops
              working. This cannot be undone.
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
                  toast.success('App deleted')
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

export default Apps
