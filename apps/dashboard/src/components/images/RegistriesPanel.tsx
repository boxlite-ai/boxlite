/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { AsciiButton, PanelNote } from '@/components/ascii'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Trash } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useCreateRegistryMutation, useDeleteRegistryMutation } from '@/hooks/mutations/useRegistryMutations'
import { useBoxesByImageQuery } from '@/hooks/queries/useBoxesByImageQuery'
import { useRegistriesQuery } from '@/hooks/queries/useRegistriesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { BoxliteError } from '@/api/errors'
import { handleApiError } from '@/lib/error-handling'
import { timeAgo } from '@/lib/format'
import { conflictBoxIds } from '@/lib/image-ref'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, RegistryCredential } from '@boxlite-ai/api-client'
import React, { useEffect, useMemo, useState } from 'react'
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
          className="text-foreground underline-offset-4 hover:underline"
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
          className="text-foreground underline-offset-4 hover:underline"
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

const ROW_GRID = 'grid grid-cols-[1fr_1fr_1fr_1.2fr_60px] items-center gap-3 px-2'

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
  const [searchParams, setSearchParams] = useSearchParams()
  const { selectedOrganization, organizationMembers, authenticatedUserHasPermission } = useSelectedOrganization()
  const { data: credentials = [], error: listError, isLoading } = useRegistriesQuery()
  const { byId } = useBoxesByImageQuery()
  const createRegistry = useCreateRegistryMutation()
  const deleteRegistry = useDeleteRegistryMutation()
  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_REGISTRIES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_REGISTRIES)

  // A deploy without a secret store answers 501: not a failure to show as one.
  const unsupported = listError instanceof BoxliteError && /not configured|unsupported/i.test(listError.message)

  useEffect(() => {
    if (listError && !unsupported) handleApiError(listError, 'Failed to fetch registry credentials')
  }, [listError, unsupported])

  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<RegistryCredential | null>(null)

  // A box's pull error links here with the host it failed on.
  useEffect(() => {
    const host = searchParams.get('connect')
    if (host && canWrite && REGISTRY_HOSTS.includes(host)) {
      setForm({ ...EMPTY_FORM, registryHost: host })
      setAdding(true)
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
    setAdding(false)
    setForm(EMPTY_FORM)
    createRegistry.reset()
  }

  const provider = PROVIDERS.find((p) => p.host === form.registryHost) ?? PROVIDERS[0]
  const prefix = normalizePrefix(form.repositoryPrefix)
  const scope = `${form.registryHost}/${prefix}*`

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
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
      closeForm()
    } catch (error) {
      if (error instanceof BoxliteError && /already exists/.test(error.message)) {
        toast.error(`${scope} already has a credential`, { description: 'Remove it first to replace it.' })
        return
      }
      handleApiError(error, `Could not connect ${form.registryHost}`)
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
      <div className="mb-[14px] flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-meta text-muted-foreground">
          A credential lets your boxes pull private images. Public images need none.
        </p>
        {canWrite && !unsupported && (
          <AsciiButton variant="primary" onClick={() => setAdding(true)}>
            Connect a registry
          </AsciiButton>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {unsupported ? (
          <div className="py-10 text-center font-mono text-meta text-muted-foreground">
            Private registries are not enabled in this environment. Public images still work.
          </div>
        ) : (
          <>
            <div
              className={cn(
                ROW_GRID,
                'border-b border-border pb-2 font-mono text-label uppercase text-muted-foreground',
              )}
            >
              <span>Registry</span>
              <span>Covers</span>
              <span>Username</span>
              <span>Added</span>
              <span className="text-right">Actions</span>
            </div>

            {credentials.map((credential) => (
              <div key={credential.id} className={cn(ROW_GRID, 'border-b border-border/60 py-[13px] text-body')}>
                <span className="truncate font-mono font-medium text-foreground">{credential.registryHost}</span>
                <span className="truncate font-mono text-meta text-muted-foreground">
                  {credential.repositoryPrefix ? `${credential.repositoryPrefix}*` : 'every repository'}
                </span>
                <span className="truncate font-mono text-meta text-muted-foreground">{credential.username}</span>
                <span className="truncate font-mono text-meta text-muted-foreground">
                  {timeAgo(credential.createdAt)}
                  {credential.createdBy && membersById.get(credential.createdBy)
                    ? ` by ${membersById.get(credential.createdBy)}`
                    : ''}
                </span>
                <div className="flex items-center justify-end">
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => setPendingDelete(credential)}
                      disabled={deleteRegistry.isPending}
                      title={`Remove the credential for ${credential.registryHost}`}
                      className="p-[5px] text-muted-foreground transition-colors hover:text-destructive disabled:opacity-40"
                    >
                      <Trash className="size-[15px]" />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {listError ? (
              <div className="py-10 text-center font-mono text-meta text-muted-foreground">
                Credentials could not be loaded.
              </div>
            ) : (
              !isLoading &&
              credentials.length === 0 && (
                <div className="flex flex-col items-center gap-4 py-10 text-center">
                  <p className="font-mono text-meta text-muted-foreground">
                    No private registry connected. Boxes can start from any public image already.
                  </p>
                  {canWrite && (
                    <AsciiButton variant="primary" onClick={() => setAdding(true)}>
                      Connect a registry
                    </AsciiButton>
                  )}
                </div>
              )
            )}

            {credentials.length > 0 && (
              <PanelNote>
                Credentials are write-only: BoxLite can pull with them and will never show them again. When several
                cover one image, the longest repository prefix wins.
              </PanelNote>
            )}
          </>
        )}
      </div>

      <Dialog open={adding} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent>
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>Connect a registry</DialogTitle>
              <DialogDescription>Stored write-only. BoxLite uses it only to pull.</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-1">
                <Label htmlFor="registry-host">Registry</Label>
                <Select value={form.registryHost} onValueChange={(value) => setForm({ ...form, registryHost: value })}>
                  <SelectTrigger id="registry-host" className="h-9 w-full font-mono">
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

              <ol className="list-decimal space-y-1 pl-5 font-mono text-meta text-muted-foreground">
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
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="registry-prefix">Only for</Label>
                <Input
                  id="registry-prefix"
                  value={form.repositoryPrefix}
                  onChange={(event) => setForm({ ...form, repositoryPrefix: event.target.value })}
                  placeholder="acme/"
                  spellCheck={false}
                  className="font-mono"
                />
                <PanelNote>
                  Repositories under this path; leave empty for the whole registry. This credential will cover{' '}
                  <span className="text-foreground">{scope}</span>.
                </PanelNote>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" disabled={createRegistry.isPending}>
                Connect
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
              <div className="space-y-2 font-mono text-meta">
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
