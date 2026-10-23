/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useRestoreApp } from '@/hooks/mutations/useAppMutations'
import { useDeletedApps } from '@/hooks/queries/useAppsQuery'
import { relTime, relFuture } from '@/lib/apps/format'
import { handleApiError } from '@/lib/error-handling'
import { useState } from 'react'
import { toast } from 'sonner'
import { GridHeader, GridRow, HoverActions, SectionTitle } from './spec'
import { ToolButton } from './SubNav'

// Deleted apps keep everything until their purge date; restoring brings back the keys and URLs as
// they were (the Boxes wake on the next request). Shown only while there is something to restore.

const GRID = 'grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.4fr)_140px] gap-3'

export function RecentlyDeleted() {
  const { data: deleted = [] } = useDeletedApps()
  const restore = useRestoreApp()
  const [busy, setBusy] = useState<string | null>(null)
  if (deleted.length === 0) return null
  const run = async (name: string) => {
    setBusy(name)
    try {
      await restore.mutateAsync(name)
      toast.success(`${name} restored`, { description: 'Its key and URLs work again; it wakes on the first request.' })
    } catch (error) {
      handleApiError(error, `Could not restore ${name}`)
    } finally {
      setBusy(null)
    }
  }
  return (
    <section className="mt-8" aria-label="Recently deleted">
      <SectionTitle title="Recently deleted" count={deleted.length} />
      <GridHeader grid={GRID} columns={['Name', 'Deleted', 'Removed for good', '']} />
      {deleted.map((app) => (
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
            <ToolButton loading={busy === app.name} label={`Restore ${app.name}`} onClick={() => void run(app.name)}>
              Restore
            </ToolButton>
          </HoverActions>
        </GridRow>
      ))}
    </section>
  )
}
