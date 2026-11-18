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
import { CheckpointGlyph } from '@/components/CheckpointGlyph'
import { CheckpointTable } from '@/components/CheckpointTable'
import {
  ResourceEmptyState,
  ResourceErrorState,
  ResourceErrorNotice,
  ResourceLoadingState,
  ResourceFilter,
} from '@/components/ResourceLayout'
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
  const hasInventory = checkpoints.data !== undefined
  const blockingError = !hasInventory && (checkpoints.isError || capabilities.isError)
  const retryFailed = () => {
    if (capabilities.isError) void capabilities.refetch()
    if (checkpoints.isError) void checkpoints.refetch()
  }
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
        <div className="resource-content">
          {capabilities.isError && (
            <ResourceErrorNotice
              title="Could not refresh checkpoint capabilities."
              retryLabel="Retry capabilities"
              retrying={capabilities.isFetching}
              onRetry={() => void capabilities.refetch()}
            />
          )}
          <ResourceEmptyState
            icon={<CheckpointGlyph />}
            title="Checkpoints unavailable"
            description={CHECKPOINTS_DISABLED_MESSAGE}
          />
        </div>
      ) : (
        <>
          <div className="resource-toolbar">
            <ResourceFilter
              label="Filter checkpoints"
              value={filter}
              onChange={setFilter}
              count={hasInventory ? rows.length : '—'}
              disabled={!hasInventory}
            />
            <div className="flex-1" />
            <Button
              variant="primary"
              className="h-11 sm:h-9"
              disabled={!canWrite || !capabilities.data?.checkpoints_enabled}
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="size-3.5" strokeWidth={1.3} /> New Checkpoint
            </Button>
          </div>
          <div className="resource-content scroll-edge mt-[14px]">
            {blockingError ? (
              <ResourceErrorState
                title="Could not load checkpoints"
                retrying={checkpoints.isFetching || capabilities.isFetching}
                onRetry={retryFailed}
              />
            ) : !hasInventory ? (
              <ResourceLoadingState title="Loading checkpoints…" />
            ) : (
              <>
                {capabilities.isError && (
                  <ResourceErrorNotice
                    title="Could not load checkpoint capabilities."
                    retryLabel="Retry capabilities"
                    retrying={capabilities.isFetching}
                    onRetry={() => void capabilities.refetch()}
                  />
                )}
                {checkpoints.isError && (
                  <ResourceErrorNotice
                    title="Could not refresh checkpoints. Showing previously loaded data."
                    retrying={checkpoints.isFetching}
                    onRetry={() => void checkpoints.refetch()}
                  />
                )}
                {boxes.isError && (
                  <ResourceErrorNotice
                    title="Could not load source boxes."
                    retrying={boxes.isFetching}
                    onRetry={() => void boxes.refetch()}
                  />
                )}
                <CheckpointTable
                  data={rows}
                  boxes={boxes.isError ? undefined : boxes.data}
                  loading={false}
                  filtered={!!filter.trim()}
                  onClearFilter={() => setFilter('')}
                  createBoxEnabled={capabilities.data?.checkpoints_enabled === true}
                  onCreateBox={setPendingBox}
                  onDelete={(checkpoint) => {
                    remove.reset()
                    setConfirmName('')
                    setPendingDelete(checkpoint)
                  }}
                />
              </>
            )}
          </div>
          {createOpen && <CheckpointCreateDialog onClose={() => setCreateOpen(false)} />}
          {pendingBox && <CheckpointBoxCreateDialog checkpoint={pendingBox} onClose={() => setPendingBox(null)} />}
          <AlertDialog
            open={!!pendingDelete}
            onOpenChange={(open) => {
              if (!open && !remove.isPending) setPendingDelete(null)
            }}
          >
            <AlertDialogContent className="max-h-[calc(100svh-3rem)] overflow-y-auto sm:max-w-[480px]">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete checkpoint?</AlertDialogTitle>
                <AlertDialogDescription>
                  <span className="font-mono text-foreground [overflow-wrap:anywhere]">{pendingDelete?.name}</span> will
                  be permanently deleted. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="flex flex-col gap-[7px]">
                <label htmlFor="checkpoint-delete-confirm" className="text-meta text-muted-foreground">
                  Type <span className="font-mono text-foreground [overflow-wrap:anywhere]">{pendingDelete?.name}</span>{' '}
                  to confirm
                </label>
                <input
                  id="checkpoint-delete-confirm"
                  aria-label="Confirm checkpoint name"
                  value={confirmName}
                  onChange={(event) => setConfirmName(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={remove.isPending}
                  className="form-field-input font-mono focus:border-destructive"
                />
              </div>
              {remove.error && (
                <p role="alert" className="text-body text-destructive [overflow-wrap:anywhere]">
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
