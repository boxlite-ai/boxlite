/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PanelNote, StatusMark } from '@/components/ascii'
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Plus, Search, Trash } from '@/components/ui/icon'
import { RoutePath } from '@/enums/RoutePath'
import { useCreateVolumeMutation } from '@/hooks/mutations/useCreateVolumeMutation'
import { useDeleteVolumeMutation } from '@/hooks/mutations/useDeleteVolumeMutation'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useVolumesQuery } from '@/hooks/queries/useVolumesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useVolumeWsSync } from '@/hooks/useVolumeWsSync'
import { handleApiError } from '@/lib/error-handling'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, VolumeDto, VolumeState } from '@boxlite-ai/api-client'
import { useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

// One definition shared by the header and every row. The header and the rows
// are separate grid containers, so a content-sized (`auto`) last column made
// each of them solve for a different width — "ACTIONS" is narrower than the
// buttons under it — and every `fr` column drifted further apart the further
// right it sat. The last column is therefore fixed, and this string exists
// once so the two can no longer diverge.
const ROW_GRID = 'grid grid-cols-[1.6fr_1.2fr_1fr_0.8fr_0.85fr_104px] items-center gap-3 px-2'

// `lastUsedAt` is written only when a box that mounts the volume is created
// (volume.service.ts:254-272), never on read or write — so it is the moment a
// mount most recently *began*, not the last time bytes moved. Labelled "latest
// mount" rather than "last used" (a long-running writer disproves that) and
// rather than "last mounted", whose past tense would suggest the mount has
// since ended — something this page has no way to know.
function timeAgo(value?: string | null): string {
  if (!value) return 'never'
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

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
// full box list — matching on id *or* name, since the API persists whichever
// the caller sent.
const Volumes: React.FC = () => {
  const queryClient = useQueryClient()
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  // Volume state changes arrive over the notification socket; keep the
  // subscription alive across the restyle (dashboard CLAUDE.md, constraint 2).
  useVolumeWsSync()

  const queryKey = useMemo(() => queryKeys.volumes.list(selectedOrganization?.id ?? ''), [selectedOrganization?.id])
  const { data: volumes = [], isLoading, error: volumesError } = useVolumesQuery()
  const createVolume = useCreateVolumeMutation()
  const deleteVolume = useDeleteVolumeMutation({ invalidateOnSuccess: false })

  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_VOLUMES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_VOLUMES)

  const [filter, setFilter] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<VolumeDto | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (volumesError) {
      handleApiError(volumesError, 'Failed to fetch volumes')
    }
  }, [volumesError])

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
    return volumes.filter(
      (v) => v.name.toLowerCase().includes(needle) || v.id.toLowerCase().includes(needle),
    )
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

  const showEmpty = !isLoading && volumes.length === 0

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
      <div className="mb-[18px] flex items-end justify-between lg:mb-[22px]">
        <h1 className="font-mono text-[22px] font-medium leading-none tracking-[-0.5px]">Volumes</h1>
      </div>

      {showEmpty ? (
        <EmptyState canCreate={canWrite} onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
            <div className="flex h-11 w-full min-w-0 items-center gap-[11px] border border-dashed border-border bg-card px-[14px] sm:h-9 sm:max-w-[380px] sm:flex-none">
              <Search className="size-[15px] shrink-0" style={{ color: 'hsl(var(--brand))' }} strokeWidth={2} />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter volumes…"
                className="w-full border-0 bg-transparent p-0 text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
              />
              <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground">
                {rows.length}
              </span>
            </div>
            <div className="flex-1" />
            {canWrite && (
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="inline-flex h-11 items-center justify-center gap-[7px] bg-primary px-[15px] text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 sm:h-9"
              >
                <Plus className="size-3.5" strokeWidth={2.4} />
                New Volume
              </button>
            )}
          </div>

          <div className="mt-[14px] flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div
              className={cn(
                ROW_GRID,
                'border-b border-border pb-2 font-mono text-[10px] uppercase tracking-[1px] text-muted-foreground',
              )}
            >
              <span>Name</span>
              <span>Volume ID</span>
              <span>Status</span>
              <span>Created</span>
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
                <div key={volume.id} className="border-b border-border/60">
                  <div className={cn(ROW_GRID, 'py-[13px] text-[13px]')}>
                    <span className="truncate font-mono font-medium text-foreground">{volume.name}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(volume.id)
                          toast.success('Volume ID copied')
                        } catch {
                          toast.error('Could not copy to clipboard')
                        }
                      }}
                      title="Copy volume ID"
                      className="truncate text-left font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {volume.id}
                    </button>
                    <span title={statusDetail} className={statusDetail ? 'cursor-help' : undefined}>
                      <StatusMark tone={STATE_TONE[volume.state] ?? 'idle'}>
                        <span className="font-mono text-[11px] uppercase tracking-[0.5px]">{volume.state}</span>
                      </StatusMark>
                    </span>
                    <span className="font-mono text-[12px] text-muted-foreground">{timeAgo(volume.createdAt)}</span>
                    <span className="font-mono text-[12px] text-muted-foreground">{timeAgo(volume.lastUsedAt)}</span>
                    {/* Space is tight, so only the promoted action keeps a
                        label; destroy is the app's established icon treatment
                        (and a little harder to hit by accident that way). */}
                    <div className="flex items-center justify-end gap-[6px]">
                      {canWrite && volume.state === VolumeState.READY && (
                        <a
                          // The id, not the name — see the mount-row comment in
                          // CreateBoxDialog: a name persisted into box.volumes
                          // is invisible to the server's delete guard.
                          href={`${RoutePath.BOXES}?createBox=1&volume=${encodeURIComponent(volume.id)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Create a box with ${volume.name} mounted (opens a new tab)`}
                          className="whitespace-nowrap border border-border px-[9px] py-[5px] font-mono text-[11px] text-muted-foreground transition-colors hover:border-brand hover:text-foreground"
                        >
                          + Box
                        </a>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteConfirmText('')
                            setPendingDelete(volume)
                          }}
                          disabled={!removable || busy[volume.id]}
                          title={removable ? 'Delete volume' : 'Only a ready or errored volume can be deleted'}
                          aria-label={`Delete ${volume.name}`}
                          className="border border-border p-[6px] text-muted-foreground transition-colors hover:border-destructive hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Trash className="size-[13px]" strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}

            {rows.length === 0 && (
              <div className="flex flex-col items-center gap-3 py-10 text-center font-mono text-[12px] text-muted-foreground">
                <span>No volume matches “{filter.trim()}”</span>
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  className="border border-border px-[13px] py-[6px] text-[11px] transition-colors hover:border-brand"
                >
                  Clear filter
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="flex w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[460px]">
          <DialogHeader className="shrink-0 border-b border-border px-4 py-[18px] sm:px-6">
            <DialogTitle className="text-[18px] font-bold tracking-[-0.3px]">New volume</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-[9px] px-4 py-5 sm:px-6">
            {/* Nothing else here says what a volume is — the payload is just a
                name — and this dialog is where someone meets the concept. */}
            <p className="mb-[5px] font-mono text-[11.5px] leading-relaxed text-muted-foreground">
              Storage that outlives a box. Mount it into a box to read and write; the data stays once that box is gone,
              and another box can mount it later.
            </p>
            <div className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Name</div>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="subtitle-models"
              aria-label="Volume name"
              aria-invalid={!nameValid}
              className="w-full border border-border bg-card px-[13px] py-[11px] font-mono text-[13px] text-foreground outline-none focus:border-brand aria-[invalid=true]:border-destructive"
            />
            {/* Name is the entire create payload — the API accepts nothing else
                — and a mount takes a name in place of an id, so this is the
                handle the user will type later. */}
            <PanelNote>Used to mount this volume into a box. It takes a few seconds to become ready.</PanelNote>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-[10px] border-t border-border px-4 py-4 sm:flex sm:justify-end sm:px-6">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="border border-border px-[18px] py-[10px] text-[13px] font-medium transition-colors hover:bg-card"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={createVolume.isPending || !newName.trim() || !nameValid}
              className="bg-primary px-5 py-[10px] text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createVolume.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </DialogContent>
      </Dialog>

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
            <label htmlFor="volume-delete-confirm" className="font-mono text-[11px] text-muted-foreground">
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
              className="w-full border border-border bg-card px-[13px] py-[10px] font-mono text-[13px] text-foreground outline-none focus:border-destructive"
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

// Most orgs land here with nothing. The copy answers the thing that sent them
// looking — a box took their data with it — instead of defining the noun.
function EmptyState({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[16px] px-6 text-center">
      <span className="size-[10px]" style={{ background: 'hsl(var(--brand))' }} />
      <div className="font-mono text-[17px] font-semibold">No volumes yet</div>
      <p className="max-w-[420px] font-mono text-[12.5px] leading-relaxed text-muted-foreground">
        A box loses everything on its disk when it is destroyed. A volume does not — mount one into a box and the data
        outlives it.
      </p>
      {canCreate && (
        <button
          type="button"
          onClick={onCreate}
          className="mt-1 inline-flex items-center gap-[7px] bg-primary px-[15px] py-[9px] text-[12.5px] font-semibold text-primary-foreground transition-opacity hover:opacity-85"
        >
          <Plus className="size-3.5" strokeWidth={2.4} />
          New Volume
        </button>
      )}
    </div>
  )
}

export default Volumes
