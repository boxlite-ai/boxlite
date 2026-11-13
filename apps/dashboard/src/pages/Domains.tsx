/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { QuotaTicks } from '@/components/QuotaTicks'
import { TechnicalText } from '@/components/TechnicalText'
import { DomainResourceIcon } from '@/components/ResourceStateIcon'
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
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Copy, Globe, Plus } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { RoutePath } from '@/enums/RoutePath'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { copyToClipboard } from '@/lib/copy-text'
import { cn } from '@/lib/utils'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
import { generatePath, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { usePageTitle } from '@/hooks/usePageTitle'

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
    <div className="page-container flex h-[var(--app-content-height,calc(100svh_-_60px))] min-h-0 flex-col pt-5 lg:pt-[26px]">
      <div className="resource-page-header">
        <h1 className="font-display text-page font-semibold text-foreground">Domains</h1>
        <p className="mt-2 text-body leading-relaxed text-muted-foreground">
          Manage the domains used to reach your Box services.
        </p>
      </div>

      <div className="grid min-h-9 shrink-0 grid-cols-1 items-start gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] [&_.resource-filter]:max-w-full">
        <ResourceFilter
          label="Filter domains"
          value={filter}
          onChange={(value) => setFilter(value)}
          count={data ? rows.length : '—'}
          disabled={!canManage || data === undefined}
        />
        <AsciiButton
          variant="primary"
          className="h-11 shrink-0 justify-self-start sm:h-9 sm:justify-self-end"
          disabled={!canClaim}
          onClick={openForm}
        >
          <Plus className="size-3.5" strokeWidth={2.4} /> Request domain
        </AsciiButton>
        {canManage && query.isSuccess && data && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground sm:col-span-2">
            <span className="inline-flex items-center gap-2 font-mono tabular-nums">
              <span>
                {data.used} / {data.limit} domains held · {data.remaining} available
              </span>
              <QuotaTicks used={data.used} limit={data.limit} />
            </span>
            {!data.domain_suffix ? (
              <span>Domain requests are unavailable on this deployment.</span>
            ) : data.remaining === 0 ? (
              <span className="text-warning">Domain limit reached. Reuse a held domain or request a higher limit.</span>
            ) : null}
          </div>
        )}
      </div>

      <div className="resource-content scroll-edge mt-[14px]">
        {!canManage ? (
          <ResourceEmptyState
            title="Permission required"
            icon={<Globe />}
            description="You need Box write permission to manage domains."
          />
        ) : data === undefined ? (
          query.isError ? (
            <ResourceErrorState
              title="Could not load domains"
              retrying={query.isFetching}
              onRetry={() => void query.refetch()}
            />
          ) : (
            <ResourceLoadingState title="Loading domains…" />
          )
        ) : (
          <>
            {query.isError && (
              <ResourceErrorNotice
                title="Could not refresh domains. Showing previously loaded data."
                retrying={query.isFetching}
                onRetry={() => void query.refetch()}
              />
            )}
            {data.domains.length === 0 ? (
              <ResourceEmptyState
                title="No Domains yet."
                icon={<Globe className="size-6" />}
                description="Request a name, then connect it to your Box using the CLI or SDK."
              />
            ) : (
              <div className="resource-content">
                <table
                  className={cn(
                    'resource-table w-full min-w-[640px] table-fixed text-left font-sans text-body',
                    rows.length === 0 && 'hidden',
                  )}
                >
                  <colgroup>
                    <col className="w-[36%]" />
                    <col className="w-[16%]" />
                    <col className="w-[26%]" />
                    <col className="w-[10%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <thead className="border-b border-border text-meta text-muted-foreground">
                    <tr>
                      {['Domain', 'Target type', 'Associated with', 'Port', 'Actions'].map((column) => (
                        <th
                          key={column}
                          scope="col"
                          className={`h-11 px-4 py-3 font-medium ${column === 'Actions' ? 'text-right' : ''}`}
                        >
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((domain) => (
                      <tr
                        key={domain.hostname}
                        className="border-b border-border/60 transition-colors hover:bg-accent/40 focus-within:bg-accent/40"
                      >
                        <td className="px-4 py-3 font-semibold text-foreground">
                          <ResourceIdentity icon={<DomainResourceIcon bound={Boolean(domain.target)} />}>
                            <span className="resource-name" title={domain.hostname}>
                              <TechnicalText value={domain.hostname} kind="hostname" />
                            </span>
                          </ResourceIdentity>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {domain.target ? (domain.target.type === 'box' ? 'Box' : 'App') : 'Unbound'}
                        </td>
                        <td className="truncate px-4 py-3 font-mono text-muted-foreground">
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
                        <td className="px-4 py-3 font-mono tabular-nums text-muted-foreground">
                          {domain.target?.type === 'box' ? domain.target.port : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <AsciiButton
                            variant="quiet"
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
                  <ResourceFilterEmptyState
                    title={`No domain matches “${filter.trim()}”`}
                    onClear={() => setFilter('')}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!claim.isPending) setOpen(next)
        }}
      >
        <DialogContent showCloseButton={!claim.isPending} className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Request domain</DialogTitle>
            <DialogDescription className="mt-2 text-body leading-relaxed">
              Reserve a third-level domain for your Box, then bind it using the CLI or SDK.
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-1 flex-col"
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
            <FormDialogBody>
              <div>
                <label htmlFor="domain-short-name" className="form-field-label">
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
                  className="h-10 font-mono text-body"
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
            </FormDialogBody>
            <DialogFooter>
              <AsciiButton disabled={claim.isPending} onClick={() => setOpen(false)}>
                Cancel
              </AsciiButton>
              <AsciiButton type="submit" variant="primary" disabled={!canClaim || !nameValid || claim.isPending}>
                {claim.isPending ? 'Requesting…' : 'Request domain'}
              </AsciiButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Remount organization-local form state when the selected organization changes. */
export default function Domains() {
  usePageTitle('Domains')
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
