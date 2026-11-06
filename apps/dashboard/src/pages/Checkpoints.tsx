// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import type { Checkpoint } from '@/api/checkpoint-types'
import { AsciiButton, PanelNote, StatusMark } from '@/components/ascii'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RoutePath } from '@/enums/RoutePath'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { formatBytes, timeAgo } from '@/lib/format'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

type Action = { kind: 'capture' } | { kind: 'create' | 'recover' | 'delete'; checkpoint: Checkpoint }
const LABELS = {
  capture: 'Capture checkpoint',
  create: 'Create Box',
  recover: 'Recover Box',
  delete: 'Delete checkpoint',
}
const TONES = { creating: 'warn', ready: 'ok', failed: 'bad', deleting: 'warn' } as const

export default function Checkpoints() {
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  if (!selectedOrganization) return <PanelNote>Select an organization to view checkpoints.</PanelNote>
  return (
    <CheckpointInventory
      key={selectedOrganization.id}
      org={selectedOrganization.id}
      canWrite={authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)}
    />
  )
}

function CheckpointInventory({ org, canWrite }: { org: string; canWrite: boolean }) {
  const api = useApi()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const [filter, setFilter] = useState('')
  const [action, setAction] = useState<Action | null>(null)
  const [box, setBox] = useState('')
  const [name, setName] = useState('')
  const checkpoints = useQuery({
    queryKey: queryKeys.checkpoints.list(org),
    queryFn: () => api.listCheckpoints(org),
    refetchInterval: (query) =>
      query.state.data?.some((checkpoint) => checkpoint.state === 'creating' || checkpoint.state === 'deleting')
        ? 2000
        : 10000,
  })
  const mutation = useMutation({
    mutationFn: async ({ action, box, name }: { action: Action; box: string; name: string }) => {
      if (!canWrite) throw new Error('Box write permission is required')
      switch (action.kind) {
        case 'capture':
          await api.createCheckpoint(org, box, name || undefined)
          return
        case 'delete':
          await api.removeCheckpoint(org, action.checkpoint.id)
          return
        case 'create':
          return api.createBoxFromCheckpoint(org, action.checkpoint.id, name || undefined)
        case 'recover':
          return api.recoverBoxFromCheckpoint(org, action.checkpoint.id, box)
      }
    },
    onSuccess: (result, variables) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.checkpoints.list(org) })
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.boxes.all, org] })
      if (!active.current) return
      setAction(null)
      if (result) navigate(generatePath(RoutePath.BOX_DETAILS, { boxId: result.box_id }))
      else toast.success(variables.action.kind === 'capture' ? 'Checkpoint capture requested' : 'Checkpoint deleted')
    },
    onError: (error) => {
      if (active.current) handleApiError(error, 'Checkpoint action failed')
    },
  })
  function open(next: Action) {
    setBox('')
    setName('')
    setAction(next)
  }
  const rows = (checkpoints.data ?? []).filter((checkpoint) =>
    `${checkpoint.name} ${checkpoint.id} ${checkpoint.source_box_id}`.toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <div className="page-container pt-5 lg:pt-[26px]">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">Checkpoints</h1>
          <p className="mt-2 text-body text-muted-foreground">
            Save a Box's disk and configuration, then create or recover Boxes from it.
          </p>
        </div>
        {canWrite && (
          <AsciiButton variant="primary" onClick={() => open({ kind: 'capture' })} disabled={mutation.isPending}>
            Capture checkpoint
          </AsciiButton>
        )}
      </div>
      <Input
        aria-label="Filter checkpoints"
        placeholder="Filter by name, ID or source Box"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="mb-4 max-w-md"
      />
      {checkpoints.isLoading && <PanelNote>Loading checkpoints…</PanelNote>}
      {checkpoints.error && (
        <div role="alert" className="mb-4 text-body text-destructive">
          Unable to load checkpoints.{' '}
          <AsciiButton size="sm" onClick={() => void checkpoints.refetch()}>
            Retry
          </AsciiButton>
        </div>
      )}
      {!checkpoints.isLoading && !checkpoints.error && rows.length === 0 && (
        <PanelNote>
          {filter ? 'No matching checkpoints.' : 'No checkpoints yet. Capture one from an existing Box.'}
        </PanelNote>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left text-body">
            <thead className="border-y border-border font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                {['Name', 'State', 'Source Box', 'Size', 'Created', 'Actions'].map((label) => (
                  <th key={label} scope="col" className="px-2 py-3 font-normal">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((checkpoint) => (
                <tr key={checkpoint.id} className="border-b border-border/60">
                  <td className="px-2 py-4">
                    <div>{checkpoint.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{checkpoint.id}</div>
                  </td>
                  <td className="max-w-64 px-2 py-4">
                    <StatusMark tone={TONES[checkpoint.state]}>{checkpoint.state}</StatusMark>
                    {checkpoint.error_reason && (
                      <p className="mt-1 break-words text-xs text-destructive">{checkpoint.error_reason}</p>
                    )}
                  </td>
                  <td className="px-2 py-4 font-mono text-xs">{checkpoint.source_box_id}</td>
                  <td className="px-2 py-4">{checkpoint.size_bytes ? formatBytes(checkpoint.size_bytes) : '—'}</td>
                  <td className="px-2 py-4" title={checkpoint.created_at}>
                    {timeAgo(checkpoint.created_at)}
                  </td>
                  <td className="px-2 py-4">
                    <div className="flex gap-2">
                      <AsciiButton
                        size="sm"
                        disabled={!canWrite || mutation.isPending || checkpoint.state !== 'ready'}
                        onClick={() => open({ kind: 'create', checkpoint })}
                        aria-label={`Create Box from ${checkpoint.name}`}
                      >
                        New Box
                      </AsciiButton>
                      <AsciiButton
                        size="sm"
                        disabled={!canWrite || mutation.isPending || checkpoint.state !== 'ready'}
                        onClick={() => open({ kind: 'recover', checkpoint })}
                        aria-label={`Recover Box from ${checkpoint.name}`}
                      >
                        Recover
                      </AsciiButton>
                      <AsciiButton
                        size="sm"
                        variant="danger"
                        disabled={!canWrite || mutation.isPending || checkpoint.state === 'creating'}
                        onClick={() => open({ kind: 'delete', checkpoint })}
                        aria-label={`Delete ${checkpoint.name}`}
                      >
                        Delete
                      </AsciiButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setAction(null)
        }}
      >
        {action && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{LABELS[action.kind]}</DialogTitle>
              <DialogDescription>
                {action.kind === 'capture'
                  ? 'Capture directly from a Box without volumes or secrets. The checkpoint remains after its source is deleted.'
                  : action.kind === 'delete'
                    ? `Delete ${action.checkpoint.name} and its stored archive. Boxes previously created from it remain available.`
                    : action.kind === 'recover'
                      ? `Replace the target Box's disk and configuration with ${action.checkpoint.name}. The target must be stopped or failed and idle.`
                      : `Create a new Box with all execution settings saved in ${action.checkpoint.name}.`}
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (canWrite && !mutation.isPending) mutation.mutate({ action, box: box.trim(), name: name.trim() })
              }}
              className="space-y-4"
            >
              {(action.kind === 'capture' || action.kind === 'recover') && (
                <div className="space-y-2">
                  <Label htmlFor="checkpoint-box">{action.kind === 'capture' ? 'Source Box' : 'Target Box'}</Label>
                  <Input
                    id="checkpoint-box"
                    required
                    maxLength={128}
                    placeholder="Box ID or name"
                    value={box}
                    onChange={(event) => setBox(event.target.value)}
                    disabled={mutation.isPending}
                  />
                </div>
              )}
              {(action.kind === 'capture' || action.kind === 'create') && (
                <div className="space-y-2">
                  <Label htmlFor="checkpoint-name">
                    {action.kind === 'capture' ? 'Checkpoint name (optional)' : 'Box name (optional)'}
                  </Label>
                  <Input
                    id="checkpoint-name"
                    maxLength={128}
                    pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={mutation.isPending}
                  />
                </div>
              )}
              <DialogFooter>
                <AsciiButton type="button" onClick={() => setAction(null)} disabled={mutation.isPending}>
                  Cancel
                </AsciiButton>
                <AsciiButton
                  type="submit"
                  variant={action.kind === 'delete' || action.kind === 'recover' ? 'dangerSolid' : 'primary'}
                  disabled={!canWrite || mutation.isPending}
                >
                  {mutation.isPending ? 'Working…' : LABELS[action.kind]}
                </AsciiButton>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
