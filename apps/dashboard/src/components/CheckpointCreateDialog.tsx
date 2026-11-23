/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useState } from 'react'
import { AsciiButton } from './ascii'
import { useQuery } from '@tanstack/react-query'
import { Box, OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { toast } from 'sonner'
import { useCreateCheckpointMutation } from '@/hooks/mutations/useCreateCheckpointMutation'
import { useCheckpointCapabilities } from '@/hooks/queries/useCheckpointCapabilities'
import { useCheckpointBoxesQuery } from '@/hooks/queries/useCheckpointBoxesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useApi } from '@/hooks/useApi'
import { queryKeys } from '@/hooks/queries/queryKeys'
import {
  isCheckpointBoxIdle,
  isCheckpointNameValid,
  checkpointErrorMessage,
  CHECKPOINT_POLL_INTERVAL,
} from '@/lib/checkpoints'
import { Dialog, DialogDescription, DialogTitle } from './ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import {
  FormDialogContent as DialogContent,
  FormDialogHeader as DialogHeader,
  FormDialogBody,
  FormDialogFooter,
} from './ui/form-dialog'

export function CheckpointCreateDialog({ box, onClose }: { box?: Box; onClose: () => void }) {
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const boxes = useCheckpointBoxesQuery(!box)
  const { boxApi } = useApi()
  const source = useQuery({
    queryKey: queryKeys.boxes.detail(selectedOrganization?.id ?? '', box?.id ?? ''),
    queryFn: async () => (await boxApi.getBox(box?.id ?? '', selectedOrganization?.id)).data,
    enabled: !!box && !!selectedOrganization,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: CHECKPOINT_POLL_INTERVAL,
  })
  const create = useCreateCheckpointMutation()
  const capabilities = useCheckpointCapabilities()
  const [name, setName] = useState('')
  const [boxId, setBoxId] = useState(box?.id ?? '')
  const eligible = (box ? (source.data ? [source.data] : []) : (boxes.data ?? [])).filter(isCheckpointBoxIdle)
  const nameValid = !name.trim() || isCheckpointNameValid(name.trim())
  const permitted = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const canSubmit =
    permitted &&
    capabilities.data?.checkpoints_enabled &&
    nameValid &&
    eligible.some((item) => item.id === boxId) &&
    !create.isPending &&
    (box ? !source.isError && !source.isFetching : !boxes.isError)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !create.isPending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Create Checkpoint</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            create.mutate(
              { boxId, name, organizationId: selectedOrganization?.id },
              {
                onSuccess: (checkpoint) => {
                  toast.success(`Creating checkpoint ${checkpoint.name}`)
                  onClose()
                },
              },
            )
          }}
        >
          <FormDialogBody>
            <DialogDescription className="text-body leading-relaxed">
              Save a stopped Box’s disk and settings for reuse.
            </DialogDescription>
            <div>
              <label htmlFor="checkpoint-source" className="form-field-label">
                Source box
              </label>
              <Select value={boxId} onValueChange={setBoxId} disabled={!!box || create.isPending}>
                <SelectTrigger
                  id="checkpoint-source"
                  aria-label="Source box"
                  className="form-field-input font-mono"
                  title={eligible.find((item) => item.id === boxId)?.name || boxId || undefined}
                >
                  <SelectValue placeholder="Select a box" />
                </SelectTrigger>
                <SelectContent className="max-h-[min(20rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)]">
                  {eligible.map((item) => (
                    <SelectItem key={item.id} value={item.id} className="font-mono text-meta [overflow-wrap:anywhere]">
                      {item.name || item.id} · {item.disk} GiB
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {(box ? source.isLoading : boxes.isLoading) && <p role="status">Loading boxes…</p>}
            {(box ? source.isError : boxes.isError) && (
              <p role="alert" className="text-meta text-destructive [overflow-wrap:anywhere]">
                Could not load boxes.{' '}
                <button
                  type="button"
                  className="underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
                  onClick={() => void (box ? source.refetch() : boxes.refetch())}
                >
                  Retry
                </button>
              </p>
            )}
            {(box ? source.isSuccess : boxes.isSuccess) && eligible.length === 0 && (
              <p className="text-body text-muted-foreground">
                No eligible boxes. Stop a box without volumes or secrets before creating a checkpoint.
              </p>
            )}
            <label className="block">
              <span className="form-field-label">Name</span>
              <input
                aria-label="Checkpoint name"
                maxLength={128}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={create.isPending}
                aria-invalid={!nameValid}
                aria-describedby="checkpoint-name-hint"
                placeholder="my-new-checkpoint"
                className="form-field-input font-mono disabled:opacity-50"
              />
              <span id="checkpoint-name-hint" className="mt-2 block text-meta leading-relaxed text-muted-foreground">
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
          </FormDialogBody>
          <FormDialogFooter>
            <AsciiButton type="button" onClick={onClose} disabled={create.isPending}>
              Cancel
            </AsciiButton>
            <AsciiButton variant="primary" type="submit" disabled={!canSubmit}>
              {create.isPending ? 'Creating…' : 'Create Checkpoint'}
            </AsciiButton>
          </FormDialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
