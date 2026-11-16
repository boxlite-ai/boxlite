/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Fragment, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import type { CiSettings } from '@/api/ci-types'
import { AsciiButton } from '@/components/ascii'
import { ChevronDown, Github, Trash } from '@/components/ui/icon'
import {
  ResourceFilterEmptyState,
  ResourceEmptyState,
  ResourceLoadingState,
  ResourceErrorState,
  ResourceErrorNotice,
  ResourceFilter,
  ResourceIdentity,
  StatusIndicator,
} from '@/components/ResourceLayout'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  FormDialogContent as DialogContent,
  FormDialogHeader as DialogHeader,
  FormDialogBody,
  FormDialogFooter as DialogFooter,
} from '@/components/ui/form-dialog'
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
  const [filter, setFilter] = useState('')
  const submitting = useRef(false)
  const hasInventory = settings.data !== undefined
  if (!owner || !hasInventory || !settings.data?.available) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="resource-toolbar mb-[14px]">
          <ResourceFilter label="Filter connections" value={filter} onChange={setFilter} count="—" disabled />
        </div>
        <div className="resource-content">
          {!owner ? (
            <ResourceEmptyState
              title="Owner access required"
              icon={<Github />}
              description="Only account owners can manage GitHub connections."
            />
          ) : settings.isError && !hasInventory ? (
            <ResourceErrorState
              title="Could not load connections"
              retrying={settings.isFetching}
              onRetry={() => void settings.refetch()}
            />
          ) : !hasInventory ? (
            <ResourceLoadingState title="Loading connections…" />
          ) : (
            <ResourceEmptyState
              title="CI unavailable"
              icon={<Github />}
              description="Hosted CI is not enabled on this deployment."
            />
          )}
        </div>
      </div>
    )
  }
  const value = settings.data!
  const needle = filter.trim().toLowerCase()
  const connections = value.connections.filter((connection) => connection.github_account.toLowerCase().includes(needle))
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
      <div className="resource-toolbar mb-[14px] items-start">
        <ResourceFilter label="Filter connections" value={filter} onChange={setFilter} count={connections.length} />
        <CiConnectionFlow organization={organization} configuration={configuration.data} />
      </div>
      {settings.isError && (
        <ResourceErrorNotice
          title="Could not refresh connections. Showing previously loaded data."
          retrying={settings.isFetching}
          onRetry={() => void settings.refetch()}
        />
      )}
      {configuration.isError && (
        <ResourceErrorNotice
          title="Unable to load GitHub App configuration."
          retryLabel="Retry GitHub configuration"
          retrying={configuration.isFetching}
          onRetry={() => void configuration.refetch()}
        />
      )}
      {message && (
        <p role="status" className="mb-3 font-sans text-meta text-muted-foreground">
          {message}
        </p>
      )}
      <div className="resource-content scroll-edge">
        {connections.length > 0 && (
          <table className="resource-table w-full min-w-[720px] table-fixed text-left font-sans text-body">
            <colgroup>
              <col className="w-[32%]" />
              <col className="w-[15%]" />
              <col className="w-[17%]" />
              <col className="w-[20%]" />
              <col className="w-[16%]" />
            </colgroup>
            <thead className="border-b border-border">
              <tr>
                {['GitHub account', 'Type', 'Listener', 'Private repositories', 'Actions'].map((title) => (
                  <th key={title} className="last:text-right">
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <Fragment key={connection.binding_id}>
                  <tr className="border-b border-border/60 transition-colors hover:bg-accent/40 focus-within:bg-accent/40">
                    <td>
                      <button
                        type="button"
                        aria-label={`Repositories for ${connection.github_account}`}
                        aria-expanded={expanded.includes(connection.binding_id)}
                        className="flex w-full min-w-0 items-center gap-2 text-left hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
                        onClick={() =>
                          setExpanded((ids) =>
                            ids.includes(connection.binding_id)
                              ? ids.filter((id) => id !== connection.binding_id)
                              : [...ids, connection.binding_id],
                          )
                        }
                      >
                        <span className="min-w-0 flex-1">
                          <ResourceIdentity icon={<Github />}>
                            <span className="resource-name" title={connection.github_account}>
                              {connection.github_account}
                            </span>
                          </ResourceIdentity>
                        </span>
                        <ChevronDown
                          aria-hidden="true"
                          className={`size-3.5 shrink-0 text-muted-foreground ${expanded.includes(connection.binding_id) ? '' : '-rotate-90'}`}
                        />
                      </button>
                    </td>
                    <td className="text-muted-foreground">
                      {connection.account_type === 'Organization' ? 'Organization' : 'Personal'}
                    </td>
                    <td>
                      <StatusIndicator
                        label={connection.listener_status}
                        title={connection.listener_status}
                        className="max-w-full [&>span:last-child]:truncate"
                        normalizeLabel={['ready', 'provisioning'].includes(connection.listener_status)}
                        color={`hsl(var(--${connection.listener_status === 'ready' ? 'success' : connection.listener_status === 'provisioning' ? 'warning' : 'muted-foreground'}))`}
                      />
                    </td>
                    <td className="text-muted-foreground">
                      {connection.allow_private_repositories ? 'Allowed' : 'Excluded'}
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <AsciiButton
                          variant="quiet"
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
                          variant="quiet-danger"
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
                    <tr className="bg-card/50">
                      <td colSpan={5}>
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
        )}
        {!connections.length &&
          (needle ? (
            <ResourceFilterEmptyState title="No matching connections" onClear={() => setFilter('')} />
          ) : (
            <ResourceEmptyState
              icon={<Github />}
              title="No GitHub accounts connected"
              description="Connect GitHub to run your workflows on BoxLite."
            />
          ))}
      </div>
      <Dialog open={!!editing} onOpenChange={(open) => !open && !busy && setEditing(null)}>
        <DialogContent>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              void update()
            }}
          >
            <DialogHeader>
              <DialogTitle>Update connection to {editing?.github_account}</DialogTitle>
              <DialogDescription>
                Running jobs continue. Workers awaiting JIT configuration may be rescheduled.
              </DialogDescription>
            </DialogHeader>
            <FormDialogBody>
              <p className="font-sans text-meta text-muted-foreground">
                {editing?.github_account} · {editing?.account_type === 'Organization' ? 'Organization' : 'Personal'}
              </p>
              <label className="flex items-center gap-2 text-body">
                <Checkbox
                  checked={editAllowPrivate}
                  disabled={busy}
                  onCheckedChange={(checked) => setEditAllowPrivate(checked === true)}
                />
                Allow private repositories
              </label>
              <p className="text-body text-muted-foreground">
                Public repositories are enabled. Private repositories must also be authorized for the App.
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
                <p role="alert" className="text-body text-destructive">
                  {message}
                </p>
              )}
            </FormDialogBody>
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
              New CI jobs stop; running jobs finish and their workers are cleaned up. Pending browser authorizations in
              this organization and device authorizations for this CI App are cancelled. You can reconnect later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction asChild>
              <AsciiButton
                variant="dangerSolid"
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
            <p role="alert" className="text-body text-destructive">
              {message}
            </p>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
