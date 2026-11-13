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
import { Dialog, DialogDescription, DialogTitle } from './ui/dialog'
import {
  FormDialogContent as DialogContent,
  FormDialogHeader as DialogHeader,
  FormDialogBody,
  FormDialogFooter,
} from './ui/form-dialog'

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
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Create Box</DialogTitle>
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
          <FormDialogBody>
            <DialogDescription className="text-body leading-relaxed">
              Create a Box from{' '}
              <span className="font-mono text-foreground [overflow-wrap:anywhere]">{checkpoint.name}</span>.
            </DialogDescription>
            <label className="block">
              <span className="form-field-label">Name</span>
              <input
                aria-label="Box name"
                maxLength={128}
                value={name}
                placeholder="my-new-box"
                onChange={(event) => setName(event.target.value)}
                disabled={create.isPending || !!admittedBoxId}
                aria-invalid={!nameValid}
                aria-describedby="checkpoint-box-name-hint"
                className="form-field-input font-mono disabled:opacity-50"
              />
              <span
                id="checkpoint-box-name-hint"
                className="mt-2 block text-meta leading-relaxed text-muted-foreground"
              >
                {nameValid
                  ? 'Leave blank to generate a name.'
                  : 'Start with a letter or number; use only letters, numbers, dots, underscores or hyphens.'}
              </span>
            </label>
            {create.error && (
              <p role="alert" className="text-meta text-destructive [overflow-wrap:anywhere]">
                {checkpointErrorMessage(create.error)}
              </p>
            )}
            {admittedBoxId && (
              <p className="text-meta">
                The import was accepted. Check this Box before starting another import.{' '}
                <Link className="underline" to={`/dashboard/boxes/${encodeURIComponent(admittedBoxId)}`}>
                  View Box
                </Link>
              </p>
            )}
          </FormDialogBody>
          <FormDialogFooter>
            <AsciiButton type="button" onClick={onClose} disabled={create.isPending}>
              Cancel
            </AsciiButton>
            <AsciiButton variant="primary" type="submit" disabled={!canSubmit}>
              {create.isPending ? 'Creating…' : 'Create Box'}
            </AsciiButton>
          </FormDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
