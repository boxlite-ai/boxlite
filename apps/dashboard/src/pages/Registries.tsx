/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Panel, PanelNote } from '@/components/ascii'
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
import { useCreateRegistryMutation, useDeleteRegistryMutation } from '@/hooks/mutations/useRegistryMutations'
import { useRegistriesQuery } from '@/hooks/queries/useRegistriesQuery'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum, RegistryCredential } from '@boxlite-ai/api-client'
import React, { useEffect, useState } from 'react'
import { toast } from 'sonner'

/**
 * The registries a login is accepted for by default, which is also what the
 * deploy gives the API and the registry proxy as REGISTRY_PROXY_UPSTREAM_HOSTS.
 * A stack configured with other hosts needs this list changed with it; either
 * way the API has the final say and refuses a host it was not given.
 */
export const REGISTRY_HOSTS = ['ghcr.io', 'docker.io', 'quay.io', 'gcr.io'] as const

/** What each registry calls its username, so a caller knows what to type. */
const USERNAME_HINT: Record<(typeof REGISTRY_HOSTS)[number], string> = {
  'ghcr.io': 'GitHub username; the password is a token with read:packages',
  'docker.io': 'Docker Hub username; the password is an access token',
  'quay.io': 'Robot account, e.g. acme+puller; the password is its token',
  'gcr.io': '_json_key; the password is a service account key file',
}

const ROW_GRID = 'grid grid-cols-[1fr_1fr_1fr_0.8fr_60px] items-center gap-3 px-2'

const EMPTY_FORM = { registryHost: 'ghcr.io', repositoryPrefix: '', username: '', password: '' }

const Registries: React.FC = () => {
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  const { data: credentials = [], error: listError, isLoading } = useRegistriesQuery()
  const createRegistry = useCreateRegistryMutation()
  const deleteRegistry = useDeleteRegistryMutation()
  const canWrite = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_REGISTRIES)
  const canDelete = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.DELETE_REGISTRIES)

  // A list that failed is not an empty one, so it is reported, as the images
  // page does, and the empty state below is kept for a list that loaded.
  useEffect(() => {
    if (listError) handleApiError(listError, 'Failed to fetch registry logins')
  }, [listError])

  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<RegistryCredential | null>(null)

  // The password is held in this form and in the one request that sends it.
  // Closing the dialog, saved or not, clears the form and the mutation's state,
  // which would otherwise keep the submitted variables, password included.
  const closeForm = () => {
    setAdding(false)
    setForm(EMPTY_FORM)
    createRegistry.reset()
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      await createRegistry.mutateAsync({
        credential: {
          registryHost: form.registryHost,
          repositoryPrefix: form.repositoryPrefix,
          username: form.username,
          password: form.password,
        },
        organizationId: selectedOrganization?.id,
      })
      toast.success(`Added a login for ${form.registryHost}`)
      closeForm()
    } catch (error) {
      handleApiError(error, `Failed to add a login for ${form.registryHost}`)
    }
  }

  const handleDelete = async (credential: RegistryCredential) => {
    setPendingDelete(null)
    try {
      await deleteRegistry.mutateAsync({ id: credential.id, organizationId: selectedOrganization?.id })
      toast.success(`Removed the login for ${credential.registryHost}`)
    } catch (error) {
      // A 409 names the boxes that still pull through it.
      handleApiError(error, `Failed to remove the login for ${credential.registryHost}`)
    }
  }

  const host = form.registryHost as (typeof REGISTRY_HOSTS)[number]

  return (
    <div className="flex h-full flex-col">
      <div className="mb-[18px] flex items-end justify-between lg:mb-[22px]">
        <h1 className="font-display text-page font-semibold text-foreground">Registries</h1>
        {canWrite && <Button onClick={() => setAdding(true)}>Add login</Button>}
      </div>

      <Panel className="mb-[14px] px-[14px] py-[12px]">
        <PanelNote>
          A login lets boxes start from private images on its registry. Once saved, its password cannot be shown again,
          not even in part: it is kept where this console and the API cannot read it, and only the registry proxy
          presents it.
        </PanelNote>
      </Panel>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div
          className={cn(ROW_GRID, 'border-b border-border pb-2 font-mono text-label uppercase text-muted-foreground')}
        >
          <span>Registry</span>
          <span>Repositories</span>
          <span>Username</span>
          <span>Added</span>
          <span className="text-right">Actions</span>
        </div>

        {credentials.map((credential) => (
          <div key={credential.id} className={cn(ROW_GRID, 'border-b border-border/60 py-[13px] text-body')}>
            <span className="truncate font-mono font-medium text-foreground">{credential.registryHost}</span>
            <span className="truncate font-mono text-meta text-muted-foreground">
              {credential.repositoryPrefix || 'All repositories'}
            </span>
            <span className="truncate font-mono text-meta text-muted-foreground">{credential.username}</span>
            <span className="font-mono text-meta text-muted-foreground">{timeAgo(credential.createdAt)}</span>
            <div className="flex items-center justify-end">
              {canDelete && (
                <button
                  type="button"
                  onClick={() => setPendingDelete(credential)}
                  disabled={deleteRegistry.isPending}
                  title={`Remove the login for ${credential.registryHost}`}
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
            Registry logins could not be loaded.
          </div>
        ) : (
          !isLoading &&
          credentials.length === 0 && (
            <div className="py-10 text-center font-mono text-meta text-muted-foreground">
              No logins yet. Public images need none.
            </div>
          )
        )}
      </div>

      <Dialog open={adding} onOpenChange={(open) => !open && closeForm()}>
        <DialogContent>
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>Add a registry login</DialogTitle>
              <DialogDescription>The password cannot be shown again once it is saved.</DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-4">
              <div className="space-y-1">
                <Label htmlFor="registry-host">Registry</Label>
                <select
                  id="registry-host"
                  value={form.registryHost}
                  onChange={(event) => setForm({ ...form, registryHost: event.target.value })}
                  className="h-9 w-full border border-border bg-card px-2 font-mono text-body"
                >
                  {REGISTRY_HOSTS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="registry-prefix">Repositories</Label>
                <Input
                  id="registry-prefix"
                  value={form.repositoryPrefix}
                  onChange={(event) => setForm({ ...form, repositoryPrefix: event.target.value })}
                  placeholder="acme/ — leave empty for all"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="registry-username">Username</Label>
                <Input
                  id="registry-username"
                  value={form.username}
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                  placeholder={USERNAME_HINT[host]}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="registry-password">Password or token</Label>
                <Input
                  id="registry-password"
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  required
                />
              </div>
              {host === 'gcr.io' && (
                <PanelNote>
                  Container Registry is now served by Artifact Registry, and many organizations forbid creating service
                  account keys. A short-lived oauth2accesstoken does not belong here: it expires within the hour.
                </PanelNote>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit" disabled={createRegistry.isPending}>
                Save login
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the login for {pendingDelete?.registryHost}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 font-mono text-meta">
                <p>
                  Its password is destroyed. Boxes still pulling through it keep the login, and the removal is refused.
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

export default Registries
