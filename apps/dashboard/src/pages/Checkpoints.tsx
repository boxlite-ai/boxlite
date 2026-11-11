/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { Checkpoint, CheckpointStatus } from '@/api/checkpoint-types'
import { CheckpointBoxCreateDialog } from '@/components/CheckpointBoxCreateDialog'
import { useCheckpointCapabilities } from '@/hooks/queries/useCheckpointCapabilities'
import { toast } from 'sonner'
import { CheckpointCreateDialog } from '@/components/CheckpointCreateDialog'
import { CheckpointTable } from '@/components/CheckpointTable'
import { ResourceFilter } from '@/components/ResourceLayout'
import { AsciiButton as Button } from '@/components/ascii'
import { Plus } from '@/components/ui/icon'
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
import { useDeleteCheckpointMutation } from '@/hooks/mutations/useDeleteCheckpointMutation'
import { useCheckpointsQuery } from '@/hooks/queries/useCheckpointsQuery'
import { useCheckpointBoxesQuery } from '@/hooks/queries/useCheckpointBoxesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { checkpointErrorMessage, CHECKPOINTS_DISABLED_MESSAGE } from '@/lib/checkpoints'
import { usePageTitle } from '@/hooks/usePageTitle'

export default function Checkpoints() {
  usePageTitle('Checkpoints')
  const { selectedOrganization } = useSelectedOrganization()
  if (!selectedOrganization) return <p className="page-container py-5">Select an organization to view checkpoints.</p>
  return <CheckpointPage key={selectedOrganization.id} />
}

function CheckpointPage() {
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const capabilities = useCheckpointCapabilities()
  const checkpoints = useCheckpointsQuery(capabilities.data?.checkpoints_enabled !== false)
  const creating = checkpoints.data?.some((checkpoint) => checkpoint.state === CheckpointStatus.CREATING) ?? false
  const boxes = useCheckpointBoxesQuery(
    capabilities.data?.checkpoints_enabled !== false,
    creating,
    checkpoints.data?.map((checkpoint) => checkpoint.source_box_id) ?? [],
  )
  const remove = useDeleteCheckpointMutation()
  const [filter, setFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [pendingBox, setPendingBox] = useState<Checkpoint | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Checkpoint | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const rows = (checkpoints.data ?? []).filter((checkpoint) =>
    `${checkpoint.name} ${checkpoint.id}`.toLowerCase().includes(filter.trim().toLowerCase()),
  )
  const disabled = capabilities.data?.checkpoints_enabled === false
  const deleteConfirmed = !!pendingDelete && confirmName === pendingDelete.name

  return (
    <div className="page-container flex h-[var(--app-content-height,calc(100svh_-_60px))] min-h-0 flex-col pt-5 lg:pt-[26px]">
      <div className="resource-page-header flex items-end justify-between">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">Checkpoints</h1>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            Save stopped Boxes as reusable disk archives.
          </p>
        </div>
      </div>
      {disabled ? (
        <p role="status" className="my-auto text-center text-muted-foreground">
          {CHECKPOINTS_DISABLED_MESSAGE}
        </p>
      ) : (
        <>
          <div className="resource-toolbar">
            <ResourceFilter label="Filter checkpoints" value={filter} onChange={setFilter} count={rows.length} />
            <div className="flex-1" />
            <Button
              variant="primary"
              className="h-11 gap-[7px] px-[15px] text-meta font-semibold tracking-normal hover:bg-primary hover:opacity-85 sm:h-9"
              disabled={!canWrite || !capabilities.data?.checkpoints_enabled}
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-3.5" strokeWidth={2.4} /> New Checkpoint
            </Button>
          </div>
          {capabilities.isError && (
            <div role="alert" className="mt-6 text-body">
              <p>Could not load checkpoint capabilities.</p>
              <Button variant="secondary" onClick={() => void capabilities.refetch()}>
                Retry capabilities
              </Button>
            </div>
          )}
          {checkpoints.isError ? (
            <div role="alert" className="mt-6 text-body">
              <p>{checkpointErrorMessage(checkpoints.error)}</p>
              <Button variant="secondary" onClick={() => void checkpoints.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="mt-[14px] min-h-0 flex-1 overflow-auto">
              <CheckpointTable
                data={rows}
                boxes={boxes.isError ? undefined : boxes.data}
                loading={checkpoints.isLoading}
                filtered={!!filter.trim()}
                onCreate={() => setCreateOpen(true)}
                createBoxEnabled={capabilities.data?.checkpoints_enabled === true}
                onCreateBox={setPendingBox}
                onDelete={(checkpoint) => {
                  remove.reset()
                  setConfirmName('')
                  setPendingDelete(checkpoint)
                }}
              />
              {boxes.isError && (
                <p role="alert" className="mt-4 text-body text-muted-foreground">
                  Could not load source boxes.{' '}
                  <button className="underline" onClick={() => void boxes.refetch()}>
                    Retry
                  </button>
                </p>
              )}
            </div>
          )}
          {createOpen && <CheckpointCreateDialog onClose={() => setCreateOpen(false)} />}
          {pendingBox && <CheckpointBoxCreateDialog checkpoint={pendingBox} onClose={() => setPendingBox(null)} />}
          <AlertDialog
            open={!!pendingDelete}
            onOpenChange={(open) => {
              if (!open && !remove.isPending) setPendingDelete(null)
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the checkpoint. You will no longer be able to restore its disk data.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex flex-col gap-[7px]">
                <label htmlFor="checkpoint-delete-confirm" className="font-mono text-meta text-muted-foreground">
                  Type <span className="text-foreground">{pendingDelete?.name}</span> to confirm
                </label>
                <input
                  id="checkpoint-delete-confirm"
                  aria-label="Confirm checkpoint name"
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={remove.isPending}
                  className="w-full border border-border bg-card px-[13px] py-[10px] font-mono text-body text-foreground outline-none focus:border-destructive"
                />
              </div>
              {remove.error && (
                <p role="alert" className="text-body text-destructive">
                  {checkpointErrorMessage(remove.error)}
                </p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={!canDelete || !deleteConfirmed || remove.isPending}
                  className="disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={(event) => {
                    event.preventDefault()
                    if (!canDelete || !deleteConfirmed || !pendingDelete || remove.isPending) return
                    remove.mutate(
                      { checkpointId: pendingDelete.id, organizationId: selectedOrganization?.id },
                      {
                        onSuccess: () => {
                          setPendingDelete(null)
                          toast.success('Checkpoint deleted')
                        },
                      },
                    )
                  }}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  )
}
