/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  ResourceFilterEmptyState,
  ResourceEmptyState,
  ResourceLoadingState,
  ResourceErrorState,
  ResourceErrorNotice,
  ResourceFilter,
  ResourceIdentity,
} from '@/components/ResourceLayout'
import {
  FormDialogContent as DialogContent,
  FormDialogHeader as DialogHeader,
  FormDialogFooter as DialogFooter,
  FormDialogBody,
} from '@/components/ui/form-dialog'
import { AsciiButton } from '@/components/ascii'
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
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Server, Trash } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  useCreateRegistryMutation,
  useDeleteRegistryMutation,
  useUpdateRegistryMutation,
} from '@/hooks/mutations/useRegistryMutations'
import { useBoxesByImageQuery } from '@/hooks/queries/useBoxesByImageQuery'
import { useRegistriesQuery } from '@/hooks/queries/useRegistriesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { BoxliteError } from '@/api/errors'
import { handleApiError } from '@/lib/error-handling'
import { timeAgo } from '@/lib/format'
import { conflictBoxIds } from '@/lib/image-ref'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, RegistryCredential } from '@boxlite-ai/api-client'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

/**
 * How to get a pull token from each registry the API accepts by default
 * (REGISTRY_PROXY_UPSTREAM_HOSTS). The API has the final say on the host; a
 * stack configured with others needs this list changed with it.
 */
interface Provider {
  host: string
  label: string
  usernameLabel: string
  usernamePlaceholder: string
  secretLabel: string
  steps: React.ReactNode[]
}

const GCR_STEPS = (host: string): Provider => ({
  host,
  label: `Google Container Registry (${host})`,
  usernameLabel: 'Username',
  usernamePlaceholder: '_json_key',
  secretLabel: 'Service account key (JSON)',
  steps: [
    <>
      Create a service account with <code className="text-foreground">roles/storage.objectViewer</code> and download a
      JSON key. The username is <code className="text-foreground">_json_key</code>; paste the whole file as the secret.
    </>,
    <>
      A short-lived <code className="text-foreground">oauth2accesstoken</code> does not work here: it expires within the
      hour. Many organizations forbid key files; Artifact Registry now serves these hosts.
    </>,
  ],
})

export const PROVIDERS: Provider[] = [
  {
    host: 'ghcr.io',
    label: 'GitHub Container Registry (ghcr.io)',
    usernameLabel: 'GitHub username',
    usernamePlaceholder: 'octocat',
    secretLabel: 'Personal access token',
    steps: [
      <>
        Create a classic token at{' '}
        <a
          href="https://github.com/settings/tokens/new?scopes=read:packages&description=BoxLite%20pull"
          target="_blank"
          rel="noreferrer"
          className="resource-guide-link"
        >
          github.com/settings/tokens
        </a>{' '}
        with only the <code className="text-foreground">read:packages</code> scope.
      </>,
      <>For an organization&rsquo;s packages, the token&rsquo;s user needs read access to them.</>,
    ],
  },
  {
    host: 'docker.io',
    label: 'Docker Hub (docker.io)',
    usernameLabel: 'Docker Hub username',
    usernamePlaceholder: 'acme',
    secretLabel: 'Access token',
    steps: [
      <>
        Create a read-only access token under{' '}
        <a
          href="https://hub.docker.com/settings/security"
          target="_blank"
          rel="noreferrer"
          className="resource-guide-link"
        >
          Account settings → Security
        </a>
        . Not your password.
      </>,
    ],
  },
  {
    host: 'quay.io',
    label: 'Quay (quay.io)',
    usernameLabel: 'Robot account',
    usernamePlaceholder: 'acme+puller',
    secretLabel: 'Robot token',
    steps: [
      <>
        Create a robot account with read permission on the repositories, under the organization&rsquo;s Robot Accounts.
        Its name has the form <code className="text-foreground">org+name</code>.
      </>,
    ],
  },
  GCR_STEPS('gcr.io'),
  GCR_STEPS('us.gcr.io'),
  GCR_STEPS('eu.gcr.io'),
  GCR_STEPS('asia.gcr.io'),
]

export const REGISTRY_HOSTS = PROVIDERS.map((p) => p.host)

const ROW_GRID = 'grid min-w-[680px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_110px] items-center gap-6'

/** The same Covers label is used for display and local filtering. */
function registryCoverage(prefix?: string): string {
  return prefix ? `${prefix}*` : 'every repository'
}

const EMPTY_FORM = { registryHost: 'ghcr.io', repositoryPrefix: '', username: '', password: '' }

/** The API wants whole path segments ending in `/`; an unterminated prefix is completed rather than refused. */
function normalizePrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+/, '')
  if (!trimmed) return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * The organization's registry credentials: what lets a box pull a private
 * image. One per registry and repository prefix; the longest matching prefix
 * is the one a pull uses.
 *
 * A credential is write-only once saved. The API can neither read it back
 * nor test it, so the row shows what was given, not whether it still works.
 */
export function RegistriesPanel() {
  const [filter, setFilter] = useState('')
  const [searchParams, setSearchParams] = useSearchParams()
  const { selectedOrganization, organizationMembers, authenticatedUserHasPermission } = useSelectedOrganization()
  const { data: inventory, error: listError, isFetching, refetch } = useRegistriesQuery()
  const credentials = inventory ?? []
  const { byId } = useBoxesByImageQuery()
  const createRegistry = useCreateRegistryMutation()
  const updateRegistry = useUpdateRegistryMutation()
  const deleteRegistry = useDeleteRegistryMutation()
  const needle = filter.trim().toLowerCase()
  const rows = credentials.filter((credential) =>
    [credential.registryHost, registryCoverage(credential.repositoryPrefix), credential.username].some((value) =>
      value?.toLowerCase().includes(needle),
    ),
  )
  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_REGISTRIES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_REGISTRIES)

  // A deploy without a secret store answers 501: not a failure to show as one.
  const unsupported = listError instanceof BoxliteError && /not configured|unsupported/i.test(listError.message)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<RegistryCredential | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<RegistryCredential | null>(null)
  const [saving, setSaving] = useState(false)
  const saveInFlight = useRef(false)
  const formSession = useRef(0)

  // A box's pull error links here with the host it failed on.
  useEffect(() => {
    const host = searchParams.get('connect')
    if (host && canWrite && REGISTRY_HOSTS.includes(host)) {
      setForm({ ...EMPTY_FORM, registryHost: host })
      setFormOpen(true)
      setSearchParams({}, { replace: true })
    }
  }, [searchParams, canWrite, setSearchParams])

  const membersById = useMemo(
    () => new Map(organizationMembers.map((member) => [member.userId, member.name || member.email])),
    [organizationMembers],
  )

  // The secret is held in this form and in the one request that sends it.
  // Closing the dialog, saved or not, clears the form and the mutation's state,
  // which would otherwise keep the submitted variables, secret included.
  const closeForm = () => {
    formSession.current++
    setFormOpen(false)
    setEditing(null)
    setForm(EMPTY_FORM)
    createRegistry.reset()
    updateRegistry.reset()
  }

  const provider = PROVIDERS.find((p) => p.host === form.registryHost) ?? PROVIDERS[0]
  const prefix = normalizePrefix(form.repositoryPrefix)
  const scope = `${form.registryHost}/${prefix}*`

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault()
    // Resetting the mutation observer clears its password but does not cancel its request.
    if (saveInFlight.current) return
    saveInFlight.current = true
    setSaving(true)
    const session = formSession.current
    try {
      if (editing) {
        await updateRegistry.mutateAsync({
          id: editing.id,
          credential: { username: form.username.trim(), password: form.password },
          organizationId: selectedOrganization?.id,
        })
        toast.success('Credential updated', {
          description: 'New pulls use the updated login. Pulls already in progress may finish with the previous login.',
        })
        if (session === formSession.current) closeForm()
        return
      }
      await createRegistry.mutateAsync({
        credential: {
          registryHost: form.registryHost,
          repositoryPrefix: prefix,
          username: form.username.trim(),
          password: form.password,
        },
        organizationId: selectedOrganization?.id,
      })
      toast.success('Connected', {
        description: `Boxes can now pull from ${scope}. The first private pull is the test: nothing here can verify the token.`,
      })
      if (session === formSession.current) closeForm()
    } catch (error) {
      if (error instanceof BoxliteError && /already exists/.test(error.message)) {
        toast.error(`${scope} already has a credential`, {
          description: 'Use Update on the existing credential to replace the login.',
        })
        return
      }
      handleApiError(
        error,
        editing ? `Could not update the credential for ${form.registryHost}` : `Could not connect ${form.registryHost}`,
      )
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  const handleDelete = async (credential: RegistryCredential) => {
    setPendingDelete(null)
    try {
      await deleteRegistry.mutateAsync({ id: credential.id, organizationId: selectedOrganization?.id })
      toast.success(`Removed the credential for ${credential.registryHost}/${credential.repositoryPrefix}`)
    } catch (error) {
      // A 409 lists, by id, the boxes that still pull through it.
      if (error instanceof BoxliteError && /cannot be removed/.test(error.message)) {
        const names = conflictBoxIds(error.message).map((id) => byId.get(id)?.name ?? id)
        toast.error('Still in use', {
          description: `Destroy ${names.join(', ')} first; they pull through this credential.`,
        })
        return
      }
      handleApiError(error, `Could not remove the credential for ${credential.registryHost}`)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!unsupported && (
        <div className="resource-toolbar mb-[14px]">
          <ResourceFilter
            label="Filter registries"
            value={filter}
            onChange={setFilter}
            count={inventory === undefined ? '—' : rows.length}
            disabled={inventory === undefined}
          />
          {canWrite && (
            <AsciiButton variant="primary" onClick={() => setFormOpen(true)}>
              Connect a registry
            </AsciiButton>
          )}
        </div>
      )}

      <div className="resource-content scroll-edge">
        {listError && inventory !== undefined && (
          <ResourceErrorNotice
            title="Could not refresh registries. Showing previously loaded data."
            retrying={isFetching}
            onRetry={() => void refetch()}
          />
        )}
        {unsupported ? (
          <ResourceEmptyState
            title="Private registries unavailable"
            icon={<Server />}
            description="Private registries are not enabled in this environment. Public images still work."
          />
        ) : (
          <>
            <div className={cn(ROW_GRID, 'resource-list-head', rows.length === 0 && 'hidden')}>
              <span>Registry</span>
              <span>Covers</span>
              <span>Username</span>
              <span>Added</span>
              <span className="text-right">Actions</span>
            </div>

            {rows.map((credential) => (
              <div key={credential.id} className={cn(ROW_GRID, 'resource-list-row')}>
                <ResourceIdentity icon={<Server />}>
                  <span className="resource-name">{credential.registryHost}</span>
                </ResourceIdentity>
                <span className="truncate font-mono text-meta text-muted-foreground">
                  {registryCoverage(credential.repositoryPrefix)}
                </span>
                <span className="truncate font-mono text-meta text-muted-foreground">{credential.username}</span>
                <span className="truncate font-mono text-meta text-muted-foreground">
                  {timeAgo(credential.createdAt)}
                  {credential.createdBy && membersById.get(credential.createdBy)
                    ? ` by ${membersById.get(credential.createdBy)}`
                    : ''}
                </span>
                <div className="flex items-center justify-end gap-1">
                  {canWrite && (
                    <AsciiButton
                      variant="quiet"
                      size="sm"
                      type="button"
                      onClick={() => {
                        setEditing(credential)
                        setForm({ ...credential, password: '' })
                        setFormOpen(true)
                      }}
                      disabled={saving || updateRegistry.isPending || deleteRegistry.isPending}
                      title={`Update the credential for ${credential.registryHost}`}
                    >
                      Update
                    </AsciiButton>
                  )}
                  {canDelete && (
                    <AsciiButton
                      variant="quiet-danger"
                      size="icon"
                      aria-label={`Remove the credential for ${credential.registryHost}`}
                      type="button"
                      onClick={() => setPendingDelete(credential)}
                      disabled={saving || deleteRegistry.isPending || updateRegistry.isPending}
                      title={`Remove the credential for ${credential.registryHost}`}
                    >
                      <Trash className="size-[15px]" />
                    </AsciiButton>
                  )}
                </div>
              </div>
            ))}

            {inventory === undefined ? (
              listError ? (
                <ResourceErrorState
                  title="Could not load private registries"
                  retrying={isFetching}
                  onRetry={() => void refetch()}
                />
              ) : (
                <ResourceLoadingState title="Loading registries…" />
              )
            ) : rows.length === 0 ? (
              credentials.length === 0 ? (
                <ResourceEmptyState
                  title="No private registries connected"
                  icon={<Server />}
                  description="Connect a registry to pull private images. Public images work without credentials."
                />
              ) : (
                <ResourceFilterEmptyState
                  title={`No registries match “${filter.trim()}”`}
                  onClear={() => setFilter('')}
                />
              )
            ) : null}
          </>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent>
          <form onSubmit={handleSave} className="flex min-h-0 flex-1 flex-col">
            <DialogHeader>
              <DialogTitle>{editing ? 'Update credential' : 'Connect a registry'}</DialogTitle>
              <DialogDescription>
                {editing
                  ? 'Replace the login for this scope. Existing boxes are preserved.'
                  : 'Connect credentials to pull private images.'}
              </DialogDescription>
            </DialogHeader>

            <FormDialogBody>
              <div className="space-y-1">
                <Label htmlFor="registry-host">Registry</Label>
                <Select
                  disabled={!!editing}
                  value={form.registryHost}
                  onValueChange={(value) => setForm({ ...form, registryHost: value })}
                >
                  <SelectTrigger id="registry-host" className="h-10 w-full font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((option) => (
                      <SelectItem key={option.host} value={option.host} className="font-mono">
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <ol className="list-decimal space-y-1 pl-5 font-sans text-meta text-muted-foreground">
                {provider.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>

              <div className="space-y-1">
                <Label htmlFor="registry-username">{provider.usernameLabel}</Label>
                <Input
                  id="registry-username"
                  value={form.username}
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                  placeholder={provider.usernamePlaceholder}
                  spellCheck={false}
                  className="font-mono"
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="registry-password">{provider.secretLabel}</Label>
                <Input
                  id="registry-password"
                  type="password"
                  autoComplete="new-password"
                  aria-describedby="registry-secret-help"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  required
                />
                <p id="registry-secret-help" className="font-sans text-meta text-muted-foreground">
                  Cannot be viewed after saving.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="registry-prefix">Only for</Label>
                <Input
                  id="registry-prefix"
                  aria-describedby="registry-prefix-help"
                  disabled={!!editing}
                  value={form.repositoryPrefix}
                  onChange={(event) => setForm({ ...form, repositoryPrefix: event.target.value })}
                  placeholder="acme/"
                  spellCheck={false}
                  className="font-mono"
                />
                <p id="registry-prefix-help" className="font-sans text-meta leading-relaxed text-muted-foreground">
                  Covers <span className="text-foreground">{scope}</span>. Leave empty for the whole registry. Longest
                  matching prefix takes precedence.
                </p>
              </div>
            </FormDialogBody>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || createRegistry.isPending || updateRegistry.isPending}>
                {editing ? 'Save changes' : 'Connect'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove the credential for {pendingDelete?.registryHost}/{pendingDelete?.repositoryPrefix}*?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 font-sans text-meta">
                <p>
                  New boxes will no longer be able to pull private images it covers. It is refused while any box still
                  pulls through it.
                </p>
                <p>
                  The secret is destroyed here; revoke the token at the registry too if it should stop working
                  everywhere.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingDelete && handleDelete(pendingDelete)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
