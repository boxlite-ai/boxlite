/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */
import { VolumeResourceIcon } from '@/components/ResourceStateIcon'

import {
  ResourceFilterEmptyState,
  ResourceEmptyState,
  ResourceLoadingState,
  ResourceErrorState,
  ResourceErrorNotice,
  ResourceFilter,
  ResourceIdentity,
} from '@/components/ResourceLayout'
import {
  FormDialogContent as DialogContent,
  FormDialogHeader as DialogHeader,
  FormDialogFooter as DialogFooter,
  FormDialogBody,
} from '@/components/ui/form-dialog'
import { AsciiButton, PanelNote, StatusMark } from '@/components/ascii'
import { CreateBoxDialog } from '@/components/Box/CreateBoxDialog'
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
import { Dialog, DialogTitle } from '@/components/ui/dialog'
import { HardDrive, Plus, Trash } from '@/components/ui/icon'
import { useCreateVolumeMutation } from '@/hooks/mutations/useCreateVolumeMutation'
import { useDeleteVolumeMutation } from '@/hooks/mutations/useDeleteVolumeMutation'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useVolumesQuery } from '@/hooks/queries/useVolumesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useVolumeWsSync } from '@/hooks/useVolumeWsSync'
import { copyToClipboard } from '@/lib/copy-text'
import { handleApiError } from '@/lib/error-handling'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, VolumeDto, VolumeState } from '@boxlite-ai/api-client'
import { useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { usePageTitle } from '@/hooks/usePageTitle'

// Must match CreateVolumeDto.VOLUME_NAME_PATTERN on the server, including
// its two-character minimum (`+`, not `*`): a one-character name is
// indistinguishable from a Windows drive letter to any `-v` parser, so the
// server rejects it and a `*` here would only turn that into a late 400.
const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]+$/

// One definition shared by the header and every row. The header and the rows
// are separate grid containers, so a content-sized (`auto`) last column made
// each of them solve for a different width — "ACTIONS" is narrower than the
// buttons under it — and every `fr` column drifted further apart the further
// right it sat. The last column is therefore fixed, and this string exists
// once so the two can no longer diverge.
const ROW_GRID =
  'grid min-w-[760px] grid-cols-[minmax(0,1.4fr)_minmax(0,1.5fr)_120px_100px_100px_104px] items-center gap-4'

// Transitional states read as `warn` rather than blending in with the healthy
// ones: a volume stuck in `pending_delete` is exactly the leak this page exists
// to surface, so it must not look calm.
const STATE_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'idle'> = {
  [VolumeState.READY]: 'ok',
  [VolumeState.CREATING]: 'warn',
  [VolumeState.PENDING_CREATE]: 'warn',
  [VolumeState.PENDING_DELETE]: 'warn',
  [VolumeState.DELETING]: 'warn',
  [VolumeState.ERROR]: 'bad',
  [VolumeState.DELETED]: 'idle',
}

// Deliberately absent: "which boxes mount this volume".
//
// The reverse lookup exists in the backend (a jsonb `@>` over `box.volumes`,
// GIN-indexed) but only inside the delete guard as a private `.getOne()` — no
// endpoint exposes it. The page previously rendered a mock stand-in, which
// meant a "used by 0 boxes" that was confidently wrong against a real API.
// Showing nothing beats showing a wrong zero. If it comes back, the honest
// source is either a new endpoint or aggregating `BoxDto.volumes` over the
// full box list, matching on the stored `volumeId` — the API resolves a name
// to the volume's id before persisting it (box.service.ts).
/** Lists persistent volumes and gates creation, mounting, and deletion by member permissions and volume state. */
const Volumes: React.FC = () => {
  usePageTitle('Volumes')
  const queryClient = useQueryClient()
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  // Volume state changes arrive over the notification socket; keep the
  // subscription alive across the restyle (dashboard CLAUDE.md, constraint 2).
  useVolumeWsSync()

  const queryKey = useMemo(() => queryKeys.volumes.list(selectedOrganization?.id ?? ''), [selectedOrganization?.id])
  const { data: inventory, error: volumesError, isFetching, refetch } = useVolumesQuery()
  const volumes = inventory ?? []
  const createVolume = useCreateVolumeMutation()
  const deleteVolume = useDeleteVolumeMutation({ invalidateOnSuccess: false })

  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_VOLUMES)
  const canCreateBox = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_VOLUMES)

  const [filter, setFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<VolumeDto | null>(null)
  const [boxVolumeId, setBoxVolumeId] = useState<string | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const updateVolumeStateInCache = useCallback(
    (volumeId: string, state: VolumeState) => {
      queryClient.setQueriesData<VolumeDto[]>({ queryKey }, (previous) =>
        previous?.map((volume) => (volume.id === volumeId ? { ...volume, state } : volume)),
      )
    },
    [queryClient, queryKey],
  )

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return volumes
    return volumes.filter((v) => v.name.toLowerCase().includes(needle) || v.id.toLowerCase().includes(needle))
  }, [volumes, filter])

  const nameValid = !newName || NAME_REGEX.test(newName)

  // Exact match, untrimmed: a pasted name with a stray space is exactly the
  // half-attention this gate exists to catch.
  const deleteConfirmed = !!pendingDelete && deleteConfirmText === pendingDelete.name

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) {
      toast.error('Volume name is required')
      return
    }
    if (!nameValid) {
      toast.error('Only letters, digits, dots, underscores and dashes are allowed in the name.')
      return
    }
    try {
      await createVolume.mutateAsync({ volume: { name }, organizationId: selectedOrganization?.id })
      setCreateOpen(false)
      setNewName('')
      toast.success(`Creating volume ${name}`)
    } catch (error) {
      handleApiError(error, 'Failed to create volume')
    }
  }

  // No local "is anything using this" pre-check: the dashboard has no endpoint
  // that can answer it, and the server already refuses with a 409 naming a
  // blocking box. Guessing locally would only ever be a second, less accurate
  // opinion about the same question.
  const handleDelete = async (volume: VolumeDto) => {
    setBusy((prev) => ({ ...prev, [volume.id]: true }))
    updateVolumeStateInCache(volume.id, VolumeState.PENDING_DELETE)
    try {
      await deleteVolume.mutateAsync({ volumeId: volume.id, organizationId: selectedOrganization?.id })
      if (selectedOrganization?.id) {
        await queryClient.invalidateQueries({ queryKey })
      }
      setPendingDelete(null)
      // Not "deleted": removal is a soft delete a reconciler finishes later, so
      // the row stays on screen until it does.
      toast.success(`Deleting volume ${volume.name}`)
    } catch (error) {
      handleApiError(error, 'Failed to delete volume')
      updateVolumeStateInCache(volume.id, volume.state)
      setPendingDelete(null)
    } finally {
      setBusy((prev) => ({ ...prev, [volume.id]: false }))
    }
  }

  const showEmpty = volumes.length === 0

  return (
    <div className="page-container flex h-[var(--app-content-height,calc(100svh_-_60px))] min-h-0 flex-col pt-5 lg:pt-[26px]">
      <div className="resource-page-header flex items-end justify-between">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">Volumes</h1>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">Persistent storage across your Boxes.</p>
        </div>
      </div>

      <div className="resource-toolbar">
        <ResourceFilter
          label="Filter volumes"
          disabled={inventory === undefined}
          value={filter}
          onChange={(value) => setFilter(value)}
          count={inventory === undefined ? '—' : rows.length}
        />
        <div className="flex-1" />
        {canWrite && (
          <AsciiButton variant="primary" className="h-11 sm:h-9" type="button" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" strokeWidth={2.4} />
            New Volume
          </AsciiButton>
        )}
      </div>

      <div className="resource-content scroll-edge mt-[14px]">
        {volumesError && inventory !== undefined && (
          <ResourceErrorNotice
            title="Could not refresh volumes. Showing previously loaded data."
            retrying={isFetching}
            onRetry={() => void refetch()}
          />
        )}
        <div className={cn(ROW_GRID, 'resource-list-head', rows.length === 0 && 'hidden')}>
          <span>Name</span>
          <span>Volume ID</span>
          <span>Status</span>
          <span>Created</span>
          {/* `lastUsedAt` is written only when a box that mounts the volume is
                  created (volume.service.ts:254-272), never on read or write — so it
                  is the moment a mount most recently *began*, not the last time bytes
                  moved. "Latest mount" rather than "last used" (a long-running writer
                  disproves that), and rather than "last mounted", whose past tense
                  would suggest the mount has since ended — which this page cannot know. */}
          <span>Latest mount</span>
          <span className="text-right">Actions</span>
        </div>

        {rows.map((volume) => {
          const removable = volume.state === VolumeState.READY || volume.state === VolumeState.ERROR
          // Both of these used to live in an expandable panel that existed
          // mainly to hold the mounted-by list. With that gone there is not
          // enough left to justify a second row, so the status cell carries
          // the explanation for the two states that have one.
          const statusDetail =
            volume.errorReason ||
            (volume.state === VolumeState.PENDING_DELETE || volume.state === VolumeState.DELETING
              ? 'Reclaiming — this can take a few minutes. The volume stays listed until it finishes.'
              : undefined)
          return (
            <div key={volume.id}>
              <div className={cn(ROW_GRID, 'resource-list-row')}>
                <ResourceIdentity icon={<VolumeResourceIcon state={volume.state} />}>
                  <span className="resource-name" title={volume.name}>
                    {volume.name}
                  </span>
                </ResourceIdentity>
                <button
                  type="button"
                  onClick={async () => {
                    if (await copyToClipboard(volume.id)) toast.success('Volume ID copied')
                    else toast.error('Could not copy to clipboard')
                  }}
                  title="Copy volume ID"
                  aria-label={`Copy volume ID ${volume.id}`}
                  className="min-w-0 text-left font-mono text-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-foreground"
                >
                  <span className="block truncate" title={volume.id}>
                    {volume.id}
                  </span>
                </button>
                <span title={statusDetail} className={statusDetail ? 'cursor-help' : undefined}>
                  <StatusMark tone={STATE_TONE[volume.state] ?? 'idle'}>{volume.state}</StatusMark>
                </span>
                <span className="font-mono text-meta text-muted-foreground">{timeAgo(volume.createdAt)}</span>
                <span className="font-mono text-meta text-muted-foreground">{timeAgo(volume.lastUsedAt)}</span>
                {/* Space is tight, so only the promoted action keeps a
                        label; destroy is the app's established icon treatment
                        (and a little harder to hit by accident that way). */}
                <div className="flex items-center justify-end gap-[6px]">
                  {canCreateBox && volume.state === VolumeState.READY && (
                    <AsciiButton
                      variant="quiet"
                      size="sm"
                      type="button"
                      // The id, not the name — see the mount-row comment in
                      // CreateBoxDialog.
                      onClick={() => setBoxVolumeId(volume.id)}
                      title={`Create a box with ${volume.name} mounted`}
                    >
                      New Box
                    </AsciiButton>
                  )}
                  {canDelete && (
                    <AsciiButton
                      variant="quiet-danger"
                      size="icon"
                      type="button"
                      onClick={() => {
                        setDeleteConfirmText('')
                        setPendingDelete(volume)
                      }}
                      disabled={!removable || busy[volume.id]}
                      title={removable ? 'Delete volume' : 'Only a ready or errored volume can be deleted'}
                      aria-label={`Delete ${volume.name}`}
                    >
                      <Trash className="size-[15px]" />
                    </AsciiButton>
                  )}
                </div>
              </div>
            </div>
          )
        })}

        {inventory === undefined ? (
          volumesError ? (
            <ResourceErrorState title="Could not load volumes" retrying={isFetching} onRetry={() => void refetch()} />
          ) : (
            <ResourceLoadingState title="Loading volumes…" />
          )
        ) : rows.length === 0 ? (
          showEmpty ? (
            <EmptyState />
          ) : (
            <ResourceFilterEmptyState title={`No volume matches “${filter.trim()}”`} onClear={() => setFilter('')} />
          )
        ) : null}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>New Volume</DialogTitle>
          </DialogHeader>
          <FormDialogBody>
            {/* Nothing else here says what a volume is — the payload is just a
                name — and this dialog is where someone meets the concept. */}
            <p className="mb-[5px] font-sans text-meta leading-relaxed text-muted-foreground">
              Storage that outlives a box. Mount it into a box to read and write; the data stays once that box is gone,
              and another box can mount it later.
            </p>
            <div className="form-field-label">Name</div>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="subtitle-models"
              aria-label="Volume name"
              aria-invalid={!nameValid}
              className="form-field-input font-mono"
            />
            {/* Name is the entire create payload — the API accepts nothing else
                — and a mount takes a name in place of an id, so this is the
                handle the user will type later. */}
            <PanelNote>Used to mount this volume into a box. It takes a few seconds to become ready.</PanelNote>
          </FormDialogBody>
          <DialogFooter>
            <AsciiButton type="button" onClick={() => setCreateOpen(false)}>
              Cancel
            </AsciiButton>
            <AsciiButton
              variant="primary"
              type="button"
              onClick={handleCreate}
              disabled={createVolume.isPending || !newName.trim() || !nameValid}
            >
              {createVolume.isPending ? 'Creating…' : 'Create'}
            </AsciiButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Opened here rather than at /boxes: the trip loses the list the user
          was reading, and the row is the only thing that knows which volume
          they meant. */}
      {boxVolumeId && (
        <CreateBoxDialog
          open
          onOpenChange={(open) => {
            if (!open) setBoxVolumeId(null)
          }}
          prefillVolume={boxVolumeId}
        />
      )}

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null)
            setDeleteConfirmText('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The volume and everything in it are removed, and this cannot be undone. Reclaiming runs in the background,
              so the volume stays listed until it finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Typing the name is the only step that scales with the damage: a
              volume is the one thing here whose contents outlive every box, so
              losing the wrong one cannot be undone by recreating it. */}
          <div className="flex flex-col gap-[7px]">
            {/* Deliberately not the uppercase label treatment used elsewhere:
                the match is case-sensitive, so rendering the name in any case
                but its own tells the user to type something that will fail. */}
            <label htmlFor="volume-delete-confirm" className="font-sans text-meta text-muted-foreground">
              Type <span className="text-foreground">{pendingDelete?.name}</span> to confirm
            </label>
            <input
              id="volume-delete-confirm"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && deleteConfirmed && pendingDelete) handleDelete(pendingDelete)
              }}
              autoComplete="off"
              spellCheck={false}
              aria-label="Confirm volume name"
              className="w-full border border-border bg-card px-[13px] py-[10px] font-mono text-body text-foreground outline-none focus:border-destructive"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!deleteConfirmed}
              className="disabled:cursor-not-allowed disabled:opacity-40"
              onClick={(e) => {
                // Radix closes the dialog on action click; without this the
                // name gate would be bypassed by an Enter on a stale focus.
                if (!deleteConfirmed) {
                  e.preventDefault()
                  return
                }
                if (pendingDelete) handleDelete(pendingDelete)
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

/**
 * Shows the next action before an organization has any volumes.
 * Only members allowed to create volumes receive the creation action.
 */
function EmptyState() {
  return (
    <ResourceEmptyState
      title="No volumes yet"
      icon={<HardDrive className="size-6" />}
      description="Create a volume, then mount it when creating a Box."
    />
  )
}

export default Volumes
