/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { Box, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { toast } from 'sonner'
import { useCreateSnapshotMutation } from '@/hooks/mutations/useCreateSnapshotMutation'
import { useSnapshotCapabilities } from '@/hooks/queries/useSnapshotCapabilities'
import { useSnapshotBoxesQuery } from '@/hooks/queries/useSnapshotBoxesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { isSnapshotBoxIdle, isSnapshotNameValid, snapshotErrorMessage, snapshotsDisabled } from '@/lib/snapshots'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

export function SnapshotCreateDialog({
  box,
  onClose,
  onUnavailable,
}: {
  box?: Box
  onClose: () => void
  onUnavailable?: () => void
}) {
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const boxes = useSnapshotBoxesQuery(!box)
  const create = useCreateSnapshotMutation()
  const capabilities = useSnapshotCapabilities()
  const [name, setName] = useState('')
  const [boxId, setBoxId] = useState(box?.id ?? '')
  const eligible = (box ? [box] : (boxes.data ?? [])).filter(isSnapshotBoxIdle)
  const nameValid = !name.trim() || isSnapshotNameValid(name.trim())
  const permitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const canSubmit =
    permitted &&
    capabilities.data?.snapshots_enabled &&
    nameValid &&
    eligible.some((item) => item.id === boxId) &&
    !create.isPending &&
    !boxes.isError

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[88vh] sm:max-w-[540px]">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-[18px] sm:px-6">
          <DialogTitle className="text-[18px] font-bold tracking-[-0.3px]">Create Snapshot</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={async (event) => {
            event.preventDefault()
            if (!canSubmit) return
            try {
              const snapshot = await create.mutateAsync({ boxId, name, organizationId: selectedOrganization?.id })
              toast.success(`Creating snapshot ${snapshot.name}`)
              onClose()
            } catch (error) {
              if (snapshotsDisabled(error)) onUnavailable?.()
            }
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
            <DialogDescription className="font-mono text-[12px] leading-relaxed">
              Save a stopped box’s disk. The snapshot stays available after its source box is deleted.
            </DialogDescription>
            <label className="flex flex-col gap-[9px]">
              <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Source box</span>
              <select
                aria-label="Source box"
                value={boxId}
                onChange={(event) => setBoxId(event.target.value)}
                disabled={!!box || create.isPending}
                className="w-full border border-border bg-card px-[13px] py-[11px] font-mono text-[13px] text-foreground outline-none focus:border-brand"
              >
                <option value="">Select a stopped box</option>
                {eligible.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name || item.id} · {item.disk} GiB
                  </option>
                ))}
              </select>
            </label>
            {!box && boxes.isLoading && <p role="status">Loading boxes…</p>}
            {!box && boxes.isError && (
              <p role="alert">
                Could not load boxes.{' '}
                <button type="button" onClick={() => void boxes.refetch()}>
                  Retry
                </button>
              </p>
            )}
            {!boxes.isLoading && !boxes.isError && eligible.length === 0 && (
              <p className="text-sm text-muted-foreground">Stop a box before creating a snapshot.</p>
            )}
            <label className="flex flex-col gap-[9px]">
              <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Name</span>
              <input
                aria-label="Snapshot name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={create.isPending}
                aria-invalid={!nameValid}
                aria-describedby="snapshot-name-hint"
                placeholder="my-new-snapshot"
                className="w-full border border-border bg-card px-[13px] py-[11px] font-mono text-[13px] text-foreground outline-none focus:border-brand aria-[invalid=true]:border-destructive"
              />
              <span id="snapshot-name-hint" className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                Auto-named like <span className="text-foreground">cozy-otter</span> when left blank.
              </span>
            </label>
            {create.error && (
              <p role="alert" className="font-mono text-[11px] text-destructive">
                {snapshotErrorMessage(create.error)}
              </p>
            )}
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-[10px] border-t border-border px-4 py-4 sm:flex sm:justify-end sm:px-6">
            <button
              type="button"
              onClick={onClose}
              className="border border-border px-[18px] py-[11px] text-[13px] font-medium transition-colors hover:bg-card focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 sm:py-[10px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="bg-primary px-5 py-[11px] text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-50 sm:py-[10px]"
            >
              {create.isPending ? 'Creating…' : 'Create Snapshot'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
