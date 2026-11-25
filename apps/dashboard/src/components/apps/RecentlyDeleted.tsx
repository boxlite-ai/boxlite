/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useAppsScope } from '@/lib/apps/client'
import { usePurgeApp, useRestoreApp } from '@/hooks/mutations/useAppMutations'
import { useDeletedApps } from '@/hooks/queries/useAppsQuery'
import { relTime, relFuture } from '@/lib/apps/format'
import type { DeletedApp } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useState } from 'react'
import { toast } from 'sonner'
import { GridHeader, GridRow, HoverActions, SectionTitle } from './spec'
import { ToolButton } from './SubNav'
import { useConfirm } from './confirm'

// Retained Apps can be restored before their purge date or permanently removed now.

const GRID = 'grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.4fr)_180px] gap-3'

export function RecentlyDeleted() {
  const { canDelete, canWrite } = useAppsScope()
  const { data: deleted = [] } = useDeletedApps()
  const restore = useRestoreApp()
  const purge = usePurgeApp()
  const [confirm, confirmElement] = useConfirm()
  const [busy, setBusy] = useState<{ name: string; action: 'restore' | 'delete' } | null>(null)
  if (deleted.length === 0) return null
  const runRestore = async (app: DeletedApp) => {
    if (Date.parse(app.purgeAfter) <= Date.now()) {
      toast.error(`Could not restore ${app.name}`, { description: 'The retention period has ended.' })
      return
    }
    setBusy({ name: app.name, action: 'restore' })
    try {
      await restore.mutateAsync(app.name)
      toast.success(`${app.name} restored`, { description: 'Its URLs work again; it wakes on the first request.' })
    } catch (error) {
      handleApiError(error, `Could not restore ${app.name}`)
    } finally {
      setBusy(null)
    }
  }
  const runDelete = async (name: string) => {
    const ok = await confirm({
      title: `Permanently delete ${name}?`,
      body: `Permanently removes ${name}, all its environments and retained data. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      danger: true,
      typeToConfirm: name,
    })
    if (!ok) return
    setBusy({ name, action: 'delete' })
    try {
      await purge.mutateAsync(name)
      toast.success(`${name} permanently deleted`)
    } catch (error) {
      handleApiError(error, `Could not permanently delete ${name}`)
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <section className="mt-8" aria-label="Recently deleted">
        <SectionTitle title="Recently deleted" count={deleted.length} />
        <div className="overflow-x-auto">
          <div className="min-w-[680px]">
            <GridHeader grid={GRID} columns={['Name', 'Deleted', 'Removed for good', '']} />
            {deleted.map((app) => {
              const expired = Date.parse(app.purgeAfter) <= Date.now()
              return (
                <GridRow key={app.name} grid={GRID}>
                  <span className="truncate text-muted-foreground">{app.name}</span>
                  <span className="text-muted-foreground" title={new Date(app.deletedAt).toLocaleString('en-US')}>
                    {relTime(app.deletedAt)}
                  </span>
                  <span className="text-foreground" title={app.purgeAfter}>
                    {new Date(app.purgeAfter).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} ·{' '}
                    {relFuture(app.purgeAfter)}
                  </span>
                  <HoverActions>
                    <ToolButton
                      disabled={!canWrite || !!busy || expired}
                      loading={busy?.name === app.name && busy.action === 'restore'}
                      label={`Restore ${app.name}`}
                      title={
                        expired ? 'The retention period has ended; this App can no longer be restored.' : undefined
                      }
                      onClick={() => void runRestore(app)}
                    >
                      Restore
                    </ToolButton>
                    <ToolButton
                      danger
                      disabled={!canDelete || !!busy}
                      loading={busy?.name === app.name && busy.action === 'delete'}
                      label={`Delete ${app.name}`}
                      onClick={() => void runDelete(app.name)}
                    >
                      Delete
                    </ToolButton>
                  </HoverActions>
                </GridRow>
              )
            })}
          </div>
        </div>
      </section>
      {confirmElement}
    </>
  )
}
