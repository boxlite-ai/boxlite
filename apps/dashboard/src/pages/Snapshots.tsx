/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Snapshot, SnapshotStatus } from '@/lib/cloudSnapshot'
import { SnapshotBoxCreateDialog } from '@/components/SnapshotBoxCreateDialog'
import { useSnapshotCapabilities } from '@/hooks/queries/useSnapshotCapabilities'
import { toast } from 'sonner'
import { SnapshotCreateDialog } from '@/components/SnapshotCreateDialog'
import { SnapshotTable } from '@/components/SnapshotTable'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus, Search } from '@/components/ui/icon'
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
import { useDeleteSnapshotMutation } from '@/hooks/mutations/useDeleteSnapshotMutation'
import { useSnapshotsQuery } from '@/hooks/queries/useSnapshotsQuery'
import { useSnapshotBoxesQuery } from '@/hooks/queries/useSnapshotBoxesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { snapshotErrorMessage, snapshotsDisabled, SNAPSHOTS_DISABLED_MESSAGE } from '@/lib/snapshots'

export default function Snapshots() {
  const { selectedOrganization } = useSelectedOrganization()
  return <SnapshotPage key={selectedOrganization?.id} />
}

function SnapshotPage() {
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const capabilities = useSnapshotCapabilities()
  const snapshots = useSnapshotsQuery()
  const creating = snapshots.data?.some((snapshot) => snapshot.status === SnapshotStatus.CREATING) ?? false
  const boxes = useSnapshotBoxesQuery(!snapshotsDisabled(snapshots.error), creating)
  const remove = useDeleteSnapshotMutation()
  const [filter, setFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingBox, setPendingBox] = useState<Snapshot | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Snapshot | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const [unavailable, setUnavailable] = useState(false)
  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_BOXES)
  const rows = (snapshots.data ?? []).filter((snapshot) =>
    `${snapshot.name} ${snapshot.id}`.toLowerCase().includes(filter.trim().toLowerCase()),
  )
  const disabled =
    capabilities.data?.snapshots_enabled === false ||
    unavailable ||
    [snapshots.error, remove.error].some(snapshotsDisabled)
  const deleteConfirmed = !!pendingDelete && confirmName === pendingDelete.name

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
      <div className="mb-[18px] flex items-end justify-between lg:mb-[22px]">
        <h1 className="font-display text-page font-semibold text-foreground">Snapshots</h1>
      </div>
      {disabled ? (
        <p role="status" className="my-auto text-center text-muted-foreground">
          {SNAPSHOTS_DISABLED_MESSAGE}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-9 w-full items-center gap-3 border border-dashed border-border bg-card px-3 sm:max-w-[380px]">
              <Search className="size-4 text-brand" />
              <input
                aria-label="Filter snapshots"
                placeholder="Filter snapshots…"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground"
              />
              <span className="font-mono text-label text-muted-foreground">{rows.length}</span>
            </div>
            <div className="flex-1" />
            <Button disabled={!canWrite || !capabilities.data?.snapshots_enabled} onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" /> New Snapshot
            </Button>
          </div>
          {snapshots.isError ? (
            <div role="alert" className="mt-6 text-sm">
              <p>{snapshotErrorMessage(snapshots.error)}</p>
              <Button variant="outline" onClick={() => void snapshots.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="mt-[14px] min-h-0 flex-1 overflow-auto">
              <SnapshotTable
                data={rows}
                boxes={boxes.isError ? undefined : boxes.data}
                loading={snapshots.isLoading}
                filtered={!!filter.trim()}
                onCreate={() => setCreateOpen(true)}
                createBoxEnabled={capabilities.data?.create_from_snapshot_enabled === true}
                onCreateBox={setPendingBox}
                onDelete={(snapshot) => {
                  remove.reset()
                  setConfirmName('')
                  setPendingDelete(snapshot)
                }}
              />
              {boxes.isError && (
                <p role="alert" className="mt-4 text-sm text-muted-foreground">
                  Could not load source boxes.{' '}
                  <button className="underline" onClick={() => void boxes.refetch()}>
                    Retry
                  </button>
                </p>
              )}
            </div>
          )}
          {createOpen && (
            <SnapshotCreateDialog onClose={() => setCreateOpen(false)} onUnavailable={() => setUnavailable(true)} />
          )}
          {pendingBox && <SnapshotBoxCreateDialog snapshot={pendingBox} onClose={() => setPendingBox(null)} />}
          <AlertDialog
            open={!!pendingDelete}
            onOpenChange={(open) => {
              if (!open) setPendingDelete(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the snapshot. You will no longer be able to restore its disk data.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <label className="space-y-2 text-sm">
                <span>Type {pendingDelete?.name} to confirm</span>
                <Input
                  aria-label="Confirm snapshot name"
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  disabled={remove.isPending}
                />
              </label>
              {remove.error && (
                <p role="alert" className="text-sm text-destructive">
                  {snapshotErrorMessage(remove.error)}
                </p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={!canDelete || !deleteConfirmed || remove.isPending}
                  onClick={async (event) => {
                    event.preventDefault()
                    if (!canDelete || !deleteConfirmed || !pendingDelete || remove.isPending) return
                    try {
                      await remove.mutateAsync({
                        snapshotId: pendingDelete.id,
                        organizationId: selectedOrganization?.id,
                      })
                      setPendingDelete(null)
                      toast.success('Snapshot deleted')
                    } catch {
                      /* Keep the confirmation and refusal visible. */
                    }
                  }}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete snapshot'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  )
}
