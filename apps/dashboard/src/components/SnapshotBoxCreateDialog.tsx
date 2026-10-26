/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { useState } from 'react'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { toast } from 'sonner'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useCreateBoxFromSnapshotMutation } from '@/hooks/mutations/useCreateBoxFromSnapshotMutation'
import { useSnapshotCapabilities } from '@/hooks/queries/useSnapshotCapabilities'
import { Snapshot } from '@/lib/cloudSnapshot'
import { snapshotErrorMessage } from '@/lib/snapshots'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function SnapshotBoxCreateDialog({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const [name, setName] = useState('')
  const create = useCreateBoxFromSnapshotMutation()
  const capabilities = useSnapshotCapabilities()
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const nameValid = !name || NAME_REGEX.test(name)
  const canSubmit =
    !!selectedOrganization &&
    snapshot.status === 'ready' &&
    !create.isPending &&
    nameValid &&
    capabilities.data?.create_from_snapshot_enabled &&
    authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[88vh] sm:max-w-[540px]">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-[18px] sm:px-6">
          <DialogTitle className="text-[18px] font-bold tracking-[-0.3px]">Create Box</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={async (event) => {
            event.preventDefault()
            if (!canSubmit || !selectedOrganization) return
            try {
              const box = await create.mutateAsync({
                snapshotId: snapshot.id,
                name,
                organizationId: selectedOrganization.id,
              })
              toast.success(`Creating box ${box.name || box.box_id}. View its progress on the Boxes page.`)
              onClose()
            } catch {
              /* Keep the server's refusal in the dialog. */
            }
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
            <DialogDescription className="font-mono text-[12px] leading-relaxed">
              Create a new box using the disk saved in “{snapshot.name}”.
            </DialogDescription>
            <label className="flex flex-col gap-[9px]">
              <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-muted-foreground">Name</span>
              <input
                aria-label="Box name"
                value={name}
                placeholder="my-new-box"
                onChange={(event) => setName(event.target.value)}
                disabled={create.isPending}
                aria-invalid={!nameValid}
                aria-describedby="snapshot-box-name-hint"
                className="w-full border border-border bg-card px-[13px] py-[11px] font-mono text-[13px] text-foreground outline-none focus:border-brand aria-[invalid=true]:border-destructive"
              />
              <span id="snapshot-box-name-hint" className="font-mono text-[11px] leading-relaxed text-muted-foreground">
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
              {create.isPending ? 'Creating…' : 'Create Box'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
