/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Plus } from '@/components/ui/icon'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'

const SHORT_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const BUTTON =
  'rounded border border-border px-3 py-2 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-40'

function OrganizationDomains({ organizationId, canManage }: { organizationId: string; canManage: boolean }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [claimedHostname, setClaimedHostname] = useState('')
  const query = useQuery({
    queryKey: queryKeys.domains.list(organizationId),
    queryFn: () => api.listDomains(organizationId),
    enabled: canManage,
  })
  const claim = useMutation({
    mutationFn: (shortName: string) => api.claimDomain(organizationId, shortName),
    onSuccess: (domain) => {
      setClaimedHostname(domain.hostname)
      setOpen(false)
      setName('')
      void queryClient.invalidateQueries({ queryKey: queryKeys.domains.list(organizationId) })
    },
  })
  const data = query.data
  const shortName = name.trim().toLowerCase()
  const nameValid = SHORT_NAME.test(shortName) && shortName.length >= (data?.min_length ?? 1) && shortName.length <= 63
  const canClaim = canManage && !!data?.domain_suffix && data.remaining > 0

  return (
    <div className="page-container flex h-[calc(100svh-60px)] min-h-0 flex-col pt-5 lg:pt-[26px]">
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">Domains</h1>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            Your organization's domains and their binding targets.
          </p>
        </div>
        <button
          className={`${BUTTON} flex items-center gap-2 border-primary text-primary`}
          disabled={!canClaim}
          onClick={() => {
            claim.reset()
            setOpen(true)
          }}
        >
          <Plus className="h-4 w-4" /> Request domain
        </button>
      </div>

      {!canManage ? (
        <p role="alert">You need Box write permission to manage domains.</p>
      ) : query.isPending ? (
        <p role="status">Loading domains…</p>
      ) : query.isError ? (
        <div role="alert" className="font-mono text-sm text-destructive">
          <p>Unable to load domains: {query.error.message}</p>
          <button className={`${BUTTON} mt-3`} onClick={() => void query.refetch()}>
            Retry
          </button>
        </div>
      ) : (
        data && (
          <>
            <p className="mb-4 font-mono text-xs text-muted-foreground">
              {data.used} / {data.limit} domains held · {data.remaining} available
            </p>
            {!data.domain_suffix && (
              <p className="mb-4 text-sm text-muted-foreground">Domain requests are unavailable on this deployment.</p>
            )}
            {data.remaining === 0 && (
              <p className="mb-4 text-sm text-muted-foreground">
                Domain limit reached. Reuse a held domain or request a higher limit.
              </p>
            )}
            {claimedHostname && (
              <p role="status" className="mb-4 break-all font-mono text-sm text-primary">
                Domain acquired: {claimedHostname}
              </p>
            )}
            <div className="overflow-auto rounded border border-border">
              <table className="w-full text-left font-mono text-xs">
                <thead className="border-b border-border bg-muted/30 text-muted-foreground">
                  <tr>
                    {['DOMAIN', 'TYPE', 'TARGET', 'PORT'].map((column) => (
                      <th key={column} className="px-4 py-3 font-normal">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.domains.map((domain) => (
                    <tr key={domain.hostname} className="border-b border-border last:border-0">
                      <td className="break-all px-4 py-4 text-foreground">{domain.hostname}</td>
                      <td className="px-4 py-4">
                        {domain.target ? (domain.target.type === 'box' ? 'Box' : 'App') : 'Unbound'}
                      </td>
                      <td className="break-all px-4 py-4">
                        {domain.target?.type === 'box' ? domain.target.box : (domain.target?.app ?? '—')}
                      </td>
                      <td className="px-4 py-4">{domain.target?.type === 'box' ? domain.target.port : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.domains.length === 0 && (
                <p className="p-8 text-center font-mono text-sm text-muted-foreground">
                  No domains yet. Request a short name to get your full domain.
                </p>
              )}
            </div>
            <p className="mt-4 font-mono text-xs text-muted-foreground">
              Bind using the full domain in the CLI or SDK. Unbinding keeps ownership and does not free a slot.
            </p>
          </>
        )
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!claim.isPending) setOpen(next)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request domain</DialogTitle>
            <DialogDescription>Choose a short name. Your domain will be held without a binding.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (canClaim && nameValid && !claim.isPending) claim.mutate(shortName)
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="domain-short-name" className="mb-2 block font-mono text-xs">
                Short name
              </label>
              <input
                id="domain-short-name"
                autoFocus
                value={name}
                maxLength={63}
                autoComplete="off"
                disabled={claim.isPending}
                onChange={(event) => {
                  setName(event.target.value)
                  claim.reset()
                }}
                className="w-full rounded border border-border bg-background px-3 py-2 font-mono text-sm"
                placeholder="my-app"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {data?.min_length}–63 letters, digits or hyphens; start and end with a letter or digit.
              </p>
            </div>
            <div className="rounded border border-border bg-muted/30 p-3">
              <p className="mb-1 text-xs text-muted-foreground">Full domain</p>
              <p className="break-all font-mono text-sm">
                {shortName || 'your-name'}.{data?.domain_suffix}
              </p>
            </div>
            {claim.isError && (
              <p role="alert" className="text-sm text-destructive">
                {claim.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={BUTTON} disabled={claim.isPending} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className={`${BUTTON} border-primary text-primary`}
                disabled={!canClaim || !nameValid || claim.isPending}
              >
                {claim.isPending ? 'Requesting…' : 'Request domain'}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function Domains() {
  const { selectedOrganization, authenticatedUserHasPermission } = useSelectedOrganization()
  if (!selectedOrganization) return <p>Select an organization to view domains.</p>
  // Remount forms/mutations when switching organizations so late claim results
  // cannot appear in another organization's page; query keys isolate their lists.
  return (
    <OrganizationDomains
      key={selectedOrganization.id}
      organizationId={selectedOrganization.id}
      canManage={authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)}
    />
  )
}
