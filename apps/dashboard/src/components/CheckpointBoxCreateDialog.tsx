/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AsciiButton } from './ascii'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { toast } from 'sonner'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useCreateBoxFromCheckpointMutation } from '@/hooks/mutations/useCreateBoxFromCheckpointMutation'
import { useCheckpointCapabilities } from '@/hooks/queries/useCheckpointCapabilities'
import { Checkpoint } from '@/api/checkpoint-types'
import { checkpointAdmittedBoxId, checkpointErrorMessage } from '@/lib/checkpoints'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function CheckpointBoxCreateDialog({ checkpoint, onClose }: { checkpoint: Checkpoint; onClose: () => void }) {
  const [name, setName] = useState('')
  const create = useCreateBoxFromCheckpointMutation()
  const admittedBoxId = checkpointAdmittedBoxId(create.error)
  const capabilities = useCheckpointCapabilities()
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const trimmedName = name.trim()
  const nameValid = !trimmedName || NAME_REGEX.test(trimmedName)
  const canSubmit =
    !!selectedOrganization &&
    checkpoint.state === 'ready' &&
    !create.isPending &&
    !admittedBoxId &&
    nameValid &&
    capabilities.data?.checkpoints_enabled &&
    authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose()
      }}
    >
      <DialogContent className="flex max-h-[92svh] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[88vh] sm:max-w-[540px]">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-[18px] sm:px-6">
          <DialogTitle className="text-section font-bold tracking-[-0.3px]">New Box</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit || !selectedOrganization) return
            create.mutate(
              { checkpointId: checkpoint.id, name, organizationId: selectedOrganization.id },
              {
                onSuccess: (box) => {
                  toast.success(`Creating box ${box.name || box.box_id}. View its progress on the Boxes page.`)
                  onClose()
                },
              },
            )
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
            <DialogDescription className="font-mono text-meta leading-relaxed">
              Create a new box inheriting the disk and execution settings saved in “{checkpoint.name}”.
            </DialogDescription>
            <label className="flex flex-col gap-[9px]">
              <span className="font-mono text-meta font-medium text-foreground">Name</span>
              <input
                aria-label="Box name"
                maxLength={128}
                value={name}
                placeholder="my-new-box"
                onChange={(event) => setName(event.target.value)}
                disabled={create.isPending || !!admittedBoxId}
                aria-invalid={!nameValid}
                aria-describedby="checkpoint-box-name-hint"
                className="w-full border border-border bg-card px-[13px] py-[11px] font-mono text-body text-foreground outline-none focus:border-brand aria-[invalid=true]:border-destructive"
              />
              <span id="checkpoint-box-name-hint" className="font-mono text-meta leading-relaxed text-muted-foreground">
                Leave blank to generate a name.
              </span>
            </label>
            {create.error && (
              <p role="alert" className="font-mono text-meta text-destructive">
                {checkpointErrorMessage(create.error)}
              </p>
            )}
            {admittedBoxId && (
              <p className="font-mono text-meta">
                The import was accepted. Check this Box before starting another import.{' '}
                <Link className="underline" to={`/dashboard/boxes/${encodeURIComponent(admittedBoxId)}`}>
                  View Box
                </Link>
              </p>
            )}
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-[10px] border-t border-border px-4 py-4 sm:flex sm:justify-end sm:px-6">
            <AsciiButton
              type="button"
              onClick={onClose}
              disabled={create.isPending}
              className="border border-border px-[18px] py-[11px] text-body font-medium transition-colors hover:bg-card focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 sm:py-[10px]"
            >
              Cancel
            </AsciiButton>
            <AsciiButton
              variant="primary"
              type="submit"
              disabled={!canSubmit}
              className="bg-primary px-5 py-[11px] text-body font-semibold text-primary-foreground transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35 disabled:cursor-not-allowed disabled:opacity-50 sm:py-[10px]"
            >
              {create.isPending ? 'Creating…' : 'Create Box'}
            </AsciiButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
