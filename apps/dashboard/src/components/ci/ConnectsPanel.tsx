/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Fragment, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import type { CiSettings } from '@/api/ci-types'
import { AsciiButton } from '@/components/ascii'
import { ChevronDown, Trash } from '@/components/ui/icon'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { CiRepositoryDetails } from './CiRepositoryDetails'
import { CiConnectionFlow } from './CiConnectionFlow'

export function ConnectsPanel() {
  const api = useApi(),
    cache = useQueryClient()
  const { selectedOrganization, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const organization = selectedOrganization!.id
  const owner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER
  const settings = useQuery({
    queryKey: ['ci-settings', organization],
    queryFn: () => api.getCiSettings(organization),
    enabled: owner,
    retry: false,
  })
  const configuration = useQuery({
    queryKey: ['ci-connect-configuration', organization],
    queryFn: () => api.getCiConnectConfiguration(organization),
    enabled: owner && settings.data?.available === true,
    retry: false,
  })
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const [pendingDelete, setPendingDelete] = useState<CiSettings['connections'][number] | null>(null)
  const [editing, setEditing] = useState<CiSettings['connections'][number] | null>(null)
  const [editAllowPrivate, setEditAllowPrivate] = useState(false)
  const [expanded, setExpanded] = useState<string[]>([])
  const submitting = useRef(false)
  if (!owner) return <p>Only account owners can manage GitHub connections.</p>
  if (settings.isPending) return <p role="status">Loading CI settings…</p>
  if (settings.isError)
    return (
      <div>
        <p role="alert">Unable to load CI settings.</p>
        <AsciiButton onClick={() => void settings.refetch()}>Retry</AsciiButton>
      </div>
    )
  const value = settings.data!
  if (!value.available) return <p>Hosted CI is not enabled on this deployment.</p>
  const update = async () => {
    if (submitting.current || !editing) return
    const binding = editing.binding_id
    submitting.current = true
    setBusy(true)
    setMessage('')
    try {
      await api.updateCiConnection(organization, binding, editAllowPrivate)
      await cache.invalidateQueries({ queryKey: ['ci-settings', organization] })
      setEditing(null)
      setMessage('Connection updated.')
    } catch {
      setMessage('Unable to update this connection. Try again.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  const remove = async () => {
    if (submitting.current || !pendingDelete) return
    const binding = pendingDelete.binding_id
    submitting.current = true
    setBusy(true)
    setMessage('')
    try {
      await api.deleteCiConnection(organization, binding)
      await cache.invalidateQueries({ queryKey: ['ci-settings', organization] })
      setPendingDelete(null)
      setMessage('Connection deleted.')
    } catch {
      setMessage('Unable to delete this connection. Try again.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-[14px] flex flex-wrap justify-end gap-2">
        <CiConnectionFlow organization={organization} configuration={configuration.data} />
      </div>
      {configuration.isError && (
        <p role="alert" className="mb-3 text-body text-muted-foreground">
          Unable to load GitHub App configuration.{' '}
          <AsciiButton size="sm" onClick={() => void configuration.refetch()}>
            Retry GitHub configuration
          </AsciiButton>
        </p>
      )}
      {message && (
        <p role="status" className="mb-3 font-mono text-meta text-muted-foreground">
          {message}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[680px] text-left text-body">
          <thead className="border-b border-border font-mono text-meta text-muted-foreground">
            <tr>
              {['GitHub account', 'Type', 'Listener', 'Private repositories', 'Actions'].map((title) => (
                <th key={title} className="px-2 pb-2 font-medium last:text-right">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.connections.map((connection) => (
              <Fragment key={connection.binding_id}>
                <tr className="border-b border-border/60">
                  <td className="px-2 py-[13px] font-mono font-medium text-foreground">
                    <button
                      type="button"
                      aria-label={`Repositories for ${connection.github_account}`}
                      aria-expanded={expanded.includes(connection.binding_id)}
                      className="inline-flex items-center gap-2 hover:text-muted-foreground"
                      onClick={() =>
                        setExpanded((ids) =>
                          ids.includes(connection.binding_id)
                            ? ids.filter((id) => id !== connection.binding_id)
                            : [...ids, connection.binding_id],
                        )
                      }
                    >
                      <ChevronDown
                        className={`size-3.5 ${expanded.includes(connection.binding_id) ? '' : '-rotate-90'}`}
                      />
                      {connection.github_account}
                    </button>
                  </td>
                  <td className="px-2 py-[13px] font-mono text-meta text-muted-foreground">
                    {connection.account_type === 'Organization' ? 'Organization' : 'Personal'}
                  </td>
                  <td className="px-2 py-[13px] font-mono text-meta text-muted-foreground">
                    {connection.listener_status}
                  </td>
                  <td className="px-2 py-[13px] font-mono text-meta text-muted-foreground">
                    {connection.allow_private_repositories ? 'Allowed' : 'Excluded'}
                  </td>
                  <td className="px-2 py-[13px] text-right">
                    <div className="flex items-center justify-end gap-1">
                      <AsciiButton
                        size="sm"
                        type="button"
                        disabled={busy}
                        title={`Update connection to ${connection.github_account}`}
                        onClick={() => {
                          setMessage('')
                          setEditAllowPrivate(connection.allow_private_repositories)
                          setEditing(connection)
                        }}
                      >
                        Update
                      </AsciiButton>
                      <AsciiButton
                        variant="danger"
                        size="icon"
                        disabled={busy}
                        onClick={() => {
                          setMessage('')
                          setPendingDelete(connection)
                        }}
                        aria-label={`Delete connection to ${connection.github_account}`}
                        title={`Delete connection to ${connection.github_account}`}
                      >
                        <Trash className="size-[15px]" />
                      </AsciiButton>
                    </div>
                  </td>
                </tr>
                {expanded.includes(connection.binding_id) && (
                  <tr>
                    <td colSpan={5} className="px-2 pb-3">
                      <CiRepositoryDetails
                        api={api}
                        organization={organization}
                        context={{ kind: 'binding', id: connection.binding_id }}
                        installation={connection.installation_id}
                        account={connection.github_account}
                        managementUrl={connection.installation_settings_url}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!value.connections.length && (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <p className="font-mono text-meta text-muted-foreground">No GitHub accounts connected.</p>
          </div>
        )}
      </div>
      <Dialog open={!!editing} onOpenChange={(open) => !open && !busy && setEditing(null)}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void update()
            }}
          >
            <DialogHeader>
              <DialogTitle>Update connection to {editing?.github_account}</DialogTitle>
              <DialogDescription>
                Update the repository policy for this connection. Jobs already running continue; workers awaiting JIT
                configuration may be rescheduled.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <p className="font-mono text-meta text-muted-foreground">
                {editing?.github_account} · {editing?.account_type === 'Organization' ? 'Organization' : 'Personal'}
              </p>
              <label className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={editAllowPrivate}
                  disabled={busy}
                  onChange={(event) => setEditAllowPrivate(event.target.checked)}
                />
                Allow private repositories
              </label>
              <p className="text-body text-muted-foreground">
                Public repositories are enabled. Enable this option to also allow private repositories authorized for
                the App.
              </p>
              {editing && (
                <CiRepositoryDetails
                  key={editing.binding_id}
                  api={api}
                  organization={organization}
                  context={{ kind: 'binding', id: editing.binding_id }}
                  installation={editing.installation_id}
                  account={editing.github_account}
                  managementUrl={editing.installation_settings_url}
                />
              )}
              {message && (
                <p role="alert" className="text-body text-muted-foreground">
                  {message}
                </p>
              )}
            </div>
            <DialogFooter>
              <AsciiButton type="button" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </AsciiButton>
              <AsciiButton variant="primary" type="submit" disabled={busy}>
                Update connection
              </AsciiButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && !busy && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete connection to {pendingDelete?.github_account}?</AlertDialogTitle>
            <AlertDialogDescription>
              New CI jobs stop using this connection. Running jobs can finish and their workers are cleaned up. Pending
              browser authorizations for all owners in this BoxLite organization, plus Device Flow authorizations for
              this CI App, are cancelled. You can reconnect later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <AsciiButton
                variant="danger"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault()
                  void remove()
                }}
              >
                Delete connection
              </AsciiButton>
            </AlertDialogAction>
          </AlertDialogFooter>
          {message && (
            <p role="alert" className="text-body text-muted-foreground">
              {message}
            </p>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
