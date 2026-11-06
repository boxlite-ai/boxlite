/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import type { CiSettings } from '@/api/ci-types'
import { AsciiButton } from '@/components/ascii'
import { Trash } from '@/components/ui/icon'
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
import { prepareCiRedirect } from '@/lib/ci-connect'

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
  const [accountType, setAccountType] = useState<'User' | 'Organization'>('User'),
    [allowPublic, setAllowPublic] = useState(false)
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<CiSettings['connections'][number] | null>(null)
  const [editing, setEditing] = useState<CiSettings['connections'][number] | null>(null)
  const [editAllowPublic, setEditAllowPublic] = useState(false)
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
  const connect = async () => {
    if (
      submitting.current ||
      !configuration.data?.apps.find((app) => app.account_type === accountType)?.web_connect_available
    )
      return
    submitting.current = true
    setBusy(true)
    setMessage('')
    try {
      const attempt = await api.startCiConnect(organization, {
        account_type: accountType,
        follow_installation: true,
        allow_public_repositories: allowPublic,
      })
      window.location.assign(prepareCiRedirect(organization, attempt))
    } catch {
      submitting.current = false
      setBusy(false)
      setMessage('Unable to start GitHub authorization. Try again.')
    }
  }
  const update = async () => {
    if (submitting.current || !editing) return
    const binding = editing.binding_id
    submitting.current = true
    setBusy(true)
    setMessage('')
    try {
      await api.updateCiConnection(organization, binding, editAllowPublic)
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
  const app = configuration.data?.apps.find((item) => item.account_type === accountType)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-[14px] flex flex-wrap justify-end gap-2">
        <AsciiButton
          variant="primary"
          onClick={() => {
            setMessage('')
            setConnectOpen(true)
          }}
          disabled={busy}
        >
          Connect GitHub
        </AsciiButton>
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
          <thead className="border-b border-border font-mono text-label uppercase text-muted-foreground">
            <tr>
              {['GitHub account', 'Type', 'Listener', 'Public repositories', 'Actions'].map((title) => (
                <th key={title} className="px-2 pb-2 font-normal last:text-right">
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {value.connections.map((connection) => (
              <tr key={connection.binding_id} className="border-b border-border/60">
                <td className="px-2 py-[13px] font-mono font-medium text-foreground">{connection.github_account}</td>
                <td className="px-2 py-[13px] font-mono text-meta text-muted-foreground">
                  {connection.account_type === 'Organization' ? 'Organization' : 'Personal'}
                </td>
                <td className="px-2 py-[13px] font-mono text-meta text-muted-foreground">
                  {connection.listener_status}
                </td>
                <td className="px-2 py-[13px] font-mono text-meta text-muted-foreground">
                  {connection.allow_public_repositories ? 'Allowed' : 'Excluded'}
                </td>
                <td className="px-2 py-[13px] text-right">
                  <div className="flex items-center justify-end gap-1">
                    <AsciiButton
                      size="sm"
                      type="button"
                      className="uppercase"
                      disabled={busy}
                      title={`Update connection to ${connection.github_account}`}
                      onClick={() => {
                        setMessage('')
                        setEditAllowPublic(connection.allow_public_repositories)
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
            ))}
          </tbody>
        </table>
        {!value.connections.length && (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <p className="font-mono text-meta text-muted-foreground">No GitHub accounts connected.</p>
            <AsciiButton
              variant="primary"
              onClick={() => {
                setMessage('')
                setConnectOpen(true)
              }}
            >
              Connect GitHub
            </AsciiButton>
          </div>
        )}
      </div>
      <Dialog open={connectOpen} onOpenChange={(open) => !busy && setConnectOpen(open)}>
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void connect()
            }}
          >
            <DialogHeader>
              <DialogTitle>Connect GitHub</DialogTitle>
              <DialogDescription>
                Authorize GitHub, then choose an installed account or install the App.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <fieldset className="space-y-2" disabled={busy}>
                <legend className="mb-2 font-mono text-meta">GitHub account type</legend>
                {(['User', 'Organization'] as const).map((type) => (
                  <label key={type} className="flex items-center gap-2 text-body">
                    <input
                      type="radio"
                      name="ci-account-type"
                      checked={accountType === type}
                      onChange={() => setAccountType(type)}
                    />
                    {type === 'User' ? 'Personal account' : 'Organization (owner required)'}
                  </label>
                ))}
              </fieldset>
              <label className="flex items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={allowPublic}
                  onChange={(event) => setAllowPublic(event.target.checked)}
                  disabled={busy}
                />
                Allow installed public repositories to run CI
              </label>
              {!app?.web_connect_available && (
                <p className="text-body text-muted-foreground">Browser connect is not configured on this deployment.</p>
              )}
              {app?.installation_url && (
                <a
                  className="font-mono text-meta text-foreground underline underline-offset-4"
                  href={app.installation_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Install or manage GitHub App ↗
                </a>
              )}
              <p className="font-mono text-meta text-muted-foreground">Workflow jobs use runs-on: boxlite-ci-runner.</p>
              {message && (
                <p role="alert" className="text-body text-muted-foreground">
                  {message}
                </p>
              )}
            </div>
            <DialogFooter>
              <AsciiButton type="button" onClick={() => setConnectOpen(false)} disabled={busy}>
                Cancel
              </AsciiButton>
              <AsciiButton variant="primary" type="submit" disabled={busy || !app?.web_connect_available}>
                Authorize GitHub
              </AsciiButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
                  checked={editAllowPublic}
                  disabled={busy}
                  onChange={(event) => setEditAllowPublic(event.target.checked)}
                />
                Allow installed public repositories to run CI
              </label>
              {editing?.account_type === 'Organization' && (
                <p className="text-body text-muted-foreground">
                  The GitHub runner group's public-repository setting must match this policy. Repository access granted
                  to the App still applies.
                </p>
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
              authorizations for this account type are cancelled. You can reconnect later.
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
