/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { AsciiButton } from '@/components/ascii'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Copy, Globe, Plus, Search } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { RoutePath } from '@/enums/RoutePath'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { copyToClipboard } from '@/lib/copy-text'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
import { generatePath, Link } from 'react-router-dom'
import { toast } from 'sonner'

const SHORT_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** List and reserve names within one organization, preserving quota and write-permission checks. */
function OrganizationDomains({ organizationId, canManage }: { organizationId: string; canManage: boolean }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')
  const query = useQuery({
    queryKey: queryKeys.domains.list(organizationId),
    queryFn: () => api.listDomains(organizationId),
    enabled: canManage,
  })
  const claim = useMutation({
    mutationFn: (shortName: string) => api.claimDomain(organizationId, shortName),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.domains.list(organizationId) })
    },
  })
  const data = query.data
  const shortName = name.trim().toLowerCase()
  const nameValid = SHORT_NAME.test(shortName) && shortName.length >= (data?.min_length ?? 1) && shortName.length <= 63
  const canClaim = canManage && !!data?.domain_suffix && data.remaining > 0
  const needle = filter.trim().toLowerCase()
  const rows = (data?.domains ?? []).filter((domain) => {
    const target = domain.target?.type === 'box' ? domain.target.box : domain.target?.app
    return `${domain.hostname} ${target ?? ''}`.toLowerCase().includes(needle)
  })
  const openForm = () => {
    claim.reset()
    setOpen(true)
  }

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
      <div className="mb-[18px] lg:mb-[22px]">
        <h1 className="font-display text-page font-semibold text-foreground">Domains</h1>
        <p className="mt-2 text-body leading-relaxed text-muted-foreground">
          Manage the domains used to reach your Box services.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex h-11 w-full min-w-0 items-center gap-[11px] border border-dashed border-border bg-card px-[14px] sm:h-9 sm:max-w-[380px]">
          <Search className="size-[15px] shrink-0 text-brand" strokeWidth={2} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter domains…"
            aria-label="Filter domains"
            disabled={!canManage || !query.isSuccess}
            className="w-full border-0 bg-transparent p-0 text-body text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <span className="font-mono text-label text-muted-foreground">{query.isSuccess ? rows.length : '—'}</span>
        </div>
        <div className="flex-1" />
        <AsciiButton variant="primary" className="h-11 sm:h-9" disabled={!canClaim} onClick={openForm}>
          <Plus className="size-3.5" strokeWidth={2.4} /> Request domain
        </AsciiButton>
      </div>

      {!canManage ? (
        <div role="alert" className="flex flex-1 items-center justify-center text-body text-muted-foreground">
          You need Box write permission to manage domains.
        </div>
      ) : query.isPending ? (
        <div role="status" className="flex flex-1 items-center justify-center text-body text-muted-foreground">
          Loading domains…
        </div>
      ) : query.isError ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-body">
          <p className="text-destructive">Unable to load domains: {query.error.message}</p>
          <AsciiButton onClick={() => void query.refetch()}>Retry</AsciiButton>
        </div>
      ) : (
        data && (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-muted-foreground">
              <span className="font-mono tabular-nums">
                {data.used} / {data.limit} domains held · {data.remaining} available
              </span>
              {!data.domain_suffix ? (
                <span>Domain requests are unavailable on this deployment.</span>
              ) : data.remaining === 0 ? (
                <span className="text-warning">
                  Domain limit reached. Reuse a held domain or request a higher limit.
                </span>
              ) : null}
            </div>

            {data.domains.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
                <div className="flex size-11 items-center justify-center border border-border bg-card">
                  <Globe className="size-5 text-muted-foreground" />
                </div>
                <h2 className="font-mono text-[17px] font-semibold">No domains yet</h2>
                <p className="max-w-[420px] text-body leading-relaxed text-muted-foreground">
                  Request a name, then connect it to your Box using the CLI or SDK.
                </p>
              </div>
            ) : (
              <div className="mt-[14px] min-h-0 flex-1 overflow-auto">
                <table className="w-full min-w-[640px] table-fixed text-left font-mono text-body">
                  <colgroup>
                    <col className="w-[36%]" />
                    <col className="w-[16%]" />
                    <col className="w-[26%]" />
                    <col className="w-[10%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <thead className="border-b border-border text-label uppercase tracking-[1px] text-muted-foreground">
                    <tr>
                      {['Domain', 'Target type', 'Associated with', 'Port', 'Actions'].map((column) => (
                        <th
                          key={column}
                          scope="col"
                          className={`px-2 pb-2 pt-1 font-normal ${column === 'Actions' ? 'text-right' : ''}`}
                        >
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((domain) => (
                      <tr key={domain.hostname} className="border-b border-border/60">
                        <td className="px-2 py-[13px] font-medium text-foreground">
                          <div className="flex items-center gap-3">
                            <Globe className="size-5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 break-all">{domain.hostname}</span>
                          </div>
                        </td>
                        <td className="px-2 py-[13px] text-muted-foreground">
                          {domain.target ? (domain.target.type === 'box' ? 'Box' : 'App') : 'Unbound'}
                        </td>
                        <td className="break-all px-2 py-[13px] text-muted-foreground">
                          {domain.target?.type === 'box' ? (
                            <Link
                              to={generatePath(RoutePath.BOX_DETAILS, { boxId: encodeURIComponent(domain.target.box) })}
                              className="text-foreground underline underline-offset-4 hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                            >
                              {domain.target.box}
                            </Link>
                          ) : (
                            (domain.target?.app ?? '—')
                          )}
                        </td>
                        <td className="px-2 py-[13px] tabular-nums text-muted-foreground">
                          {domain.target?.type === 'box' ? domain.target.port : '—'}
                        </td>
                        <td className="px-2 py-[13px] text-right">
                          <AsciiButton
                            size="icon"
                            aria-label={`Copy ${domain.hostname}`}
                            title="Copy domain"
                            onClick={async () => {
                              if (await copyToClipboard(domain.hostname)) toast.success('Domain copied')
                              else toast.error('Could not copy domain. Select the hostname and copy it manually.')
                            }}
                          >
                            <Copy className="size-3.5" />
                          </AsciiButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length === 0 && (
                  <div className="flex flex-col items-center gap-3 py-10 text-center text-body text-muted-foreground">
                    <p>No domain matches “{filter.trim()}”</p>
                    <AsciiButton size="sm" onClick={() => setFilter('')}>
                      Clear filter
                    </AsciiButton>
                  </div>
                )}
              </div>
            )}
            <details className="shrink-0 border-t border-border py-4 text-label leading-relaxed text-muted-foreground">
              <summary className="w-fit cursor-pointer hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                How to connect a domain
              </summary>
              <p className="mt-2 max-w-2xl">
                Bind the full domain to your Box and port using the CLI or SDK. Requesting a name only reserves it.
                Unbinding keeps ownership and does not free a slot.
              </p>
            </details>
          </>
        )
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!claim.isPending) setOpen(next)
        }}
      >
        <DialogContent
          showCloseButton={!claim.isPending}
          className="flex w-[calc(100vw-1rem)] flex-col gap-0 overflow-y-auto p-0 sm:max-w-[460px]"
        >
          <DialogHeader className="shrink-0 border-b border-border px-4 py-[18px] sm:px-6">
            <DialogTitle className="text-[18px] font-bold tracking-[-0.3px]">Request domain</DialogTitle>
            <DialogDescription className="mt-2 text-body leading-relaxed">
              Reserve a third-level domain for your Box, then bind it using the CLI or SDK.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (canClaim && nameValid && !claim.isPending)
                claim.mutate(shortName, {
                  // Observer callbacks stop on unmount; old-org cache invalidation stays in the mutation hook.
                  onSuccess: (domain) => {
                    setOpen(false)
                    setName('')
                    setFilter('')
                    toast.success('Domain reserved', { description: domain.hostname })
                  },
                })
            }}
          >
            <div className="space-y-4 px-4 py-5 sm:px-6">
              <div>
                <label
                  htmlFor="domain-short-name"
                  className="mb-2 block font-mono text-label uppercase tracking-[1px] text-muted-foreground"
                >
                  Short name
                </label>
                <Input
                  id="domain-short-name"
                  autoFocus
                  value={name}
                  maxLength={63}
                  autoComplete="off"
                  disabled={claim.isPending}
                  aria-describedby="domain-name-rules"
                  aria-invalid={!!name && !nameValid}
                  onChange={(event) => {
                    setName(event.target.value)
                    claim.reset()
                  }}
                  className="h-11 bg-card font-mono text-body"
                  placeholder="my-app"
                />
                <p id="domain-name-rules" className="mt-2 text-label leading-relaxed text-muted-foreground">
                  {data?.min_length}–63 letters, digits or hyphens; start and end with a letter or digit.
                </p>
              </div>
              <div className="border border-border bg-card px-3 py-3">
                <p className="mb-1 text-label text-muted-foreground">Full domain</p>
                <p aria-live="polite" className="break-all font-mono text-body text-foreground">
                  {shortName || 'your-name'}.{data?.domain_suffix}
                </p>
              </div>
              {claim.isError && (
                <p role="alert" className="text-body text-destructive">
                  {claim.error.message}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-[10px] border-t border-border px-4 py-4 sm:flex sm:justify-end sm:px-6">
              <AsciiButton disabled={claim.isPending} onClick={() => setOpen(false)}>
                Cancel
              </AsciiButton>
              <AsciiButton type="submit" variant="primary" disabled={!canClaim || !nameValid || claim.isPending}>
                {claim.isPending ? 'Requesting…' : 'Request domain'}
              </AsciiButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Remount organization-local form state when the selected organization changes. */
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
