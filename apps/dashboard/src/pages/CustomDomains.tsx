/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import React, { useEffect, useState } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { Dialog, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { FormDialogContent, FormDialogHeader, FormDialogBody, FormDialogFooter } from '@/components/ui/form-dialog'
import { AsciiButton } from '@/components/ascii'
import { ResourceEmptyState, StatusIndicator } from '@/components/ResourceLayout'
import { Copy, Globe, Plus, ArrowRightIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { copyToClipboard } from '@/lib/copy-text'
import { toast } from 'sonner'
import type { CustomDomain, CustomDomainList, HeldDomain } from '@/api/domain-types'

const ERRORS: Record<string, string> = {
  ownership_txt_mismatch: 'The TXT record does not match this configuration. Copy the current value below.',
  traffic_cname_mismatch: 'Point the traffic CNAME to the exact platform endpoint below.',
  traffic_address_mismatch:
    'Traffic resolves to another address. Disable CDN proxying and remove conflicting A/AAAA records.',
  dns_record_missing: 'A DNS record is missing. Check the names and allow time for DNS propagation.',
  dns_unavailable: 'DNS could not be checked. Retry when you are ready.',
  certificate_dns_mismatch:
    'The certificate authorization CNAME is missing or does not match. Copy its exact name and value below; do not replace the traffic CNAME.',
  confirmation_required: 'Configure all three records, then confirm to verify DNS.',
  domain_superseded: 'A newer verified application owns this hostname. This configuration is no longer valid.',
  domain_creation_limited: 'Wait for pending resource cleanup before creating another configuration.',
  domain_already_owned: 'This hostname is already held by another organization. Release it there before retrying.',
  provider_capacity_exhausted:
    'The HTTPS service has reached capacity. Contact support; platform domain allowance is separate.',
  provider_permission_denied: 'The HTTPS service needs platform attention. Contact support.',
  provider_unavailable: 'The HTTPS service is temporarily unavailable. Return here to continue checking.',
  provider_resource_conflict: 'The HTTPS configuration needs platform attention. Contact support.',
  provider_invalid_response:
    'The HTTPS service returned an unexpected response. Contact support if checks keep failing.',
  certificate_provisioning_failed: 'HTTPS setup could not be completed. Please try again.',
  certificate_renewal_failed:
    'HTTPS certificate renewal needs attention. Contact support@boxlite.ai. Your existing configuration is retained.',
  provider_request_rejected:
    'The certificate request was rejected. Correct the reported configuration or contact support before retrying.',
  https_not_ready: 'The certificate is not yet available at every entry point. Return here to continue checking.',
  subscription_required: 'An active organization subscription is required. Your configuration is retained.',
  subscription_not_ready:
    'Subscription eligibility could not be confirmed. Access pauses when the current grant expires.',
}

function needsDnsPreparation(domain: CustomDomain) {
  return (
    !domain.confirmed &&
    !domain.ready &&
    domain.phase !== 'superseded' &&
    domain.dnsRecords.length < 3 &&
    (!domain.errorCode || domain.errorCode === 'dns_configuration_pending')
  )
}

function DomainStatus({ domain, active }: { domain: CustomDomain; active: boolean }) {
  const label =
    domain.phase === 'superseded'
      ? 'Replaced'
      : domain.errorCode
        ? 'Needs attention'
        : domain.ready
          ? active
            ? 'Ready'
            : 'Setup completed'
          : domain.confirmed
            ? 'Waiting for HTTPS CA'
            : domain.dnsRecords.length
              ? 'Waiting for DNS verification'
              : 'Getting DNS configuration'
  return (
    <StatusIndicator
      label={label}
      normalizeLabel={label !== 'Waiting for HTTPS CA'}
      color={`hsl(var(--${domain.errorCode ? 'warning' : domain.ready && active ? 'brand' : 'muted-foreground'}))`}
    />
  )
}

export default function CustomDomains({
  organizationId,
  canManage,
  held,
}: {
  organizationId: string
  canManage: boolean
  held: HeldDomain[]
}) {
  const api = useApi()
  const client = useQueryClient()
  const key = ['custom-domains', organizationId]
  const [open, setOpen] = useState(false)
  const [hostname, setHostname] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [box, setBox] = useState('')
  const [port, setPort] = useState('3000')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [preparing, setPreparing] = useState<{ id: string; organizationId: string } | null>(null)
  const pendingMutations = useIsMutating({ mutationKey: key })
  const canRefreshStatus = (data: CustomDomainList | undefined) =>
    pendingMutations === 0 &&
    !!data?.enabled &&
    data.domains.some(
      (item) => !item.ready && item.phase !== 'superseded' && (!open || (item.id === selected && item.confirmed)),
    )
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.listCustomDomains(organizationId),
    enabled: canManage,
    refetchOnWindowFocus: (query) => (canRefreshStatus(query.state.data) ? 'always' : false),
    refetchOnReconnect: (query) => (canRefreshStatus(query.state.data) ? 'always' : false),
    refetchInterval: (query) => (canRefreshStatus(query.state.data) ? 60_000 : false),
    refetchIntervalInBackground: false,
    retry: false,
  })
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: key }),
      client.invalidateQueries({ queryKey: queryKeys.domains.list(organizationId) }),
    ])
  }
  const saveDomain = (result: CustomDomain) => {
    client.setQueryData<CustomDomainList>(key, (current) => {
      if (!current) return current
      const exists = current.domains.some((item) => item.id === result.id)
      return {
        ...current,
        domains: exists
          ? current.domains.map((item) => (item.id === result.id ? result : item))
          : [...current.domains, result],
      }
    })
  }
  const receivePreparation = (result: CustomDomain) => {
    saveDomain(result)
    setSelected(result.id)
    setPreparing(needsDnsPreparation(result) ? { id: result.id, organizationId } : null)
  }
  const create = useMutation({
    mutationKey: key,
    onMutate: () => client.cancelQueries({ queryKey: key }),
    mutationFn: () => api.createCustomDomain(organizationId, hostname),
    onSuccess: receivePreparation,
  })
  const action = useMutation({
    mutationKey: key,
    onMutate: () => client.cancelQueries({ queryKey: key }),
    mutationFn: async (operation: {
      type: 'verify' | 'prepare' | 'retry' | 'delete' | 'bind' | 'unbind'
      id: string
      hostname: string
    }) => {
      if (operation.type === 'verify') return api.verifyCustomDomain(organizationId, operation.id)
      if (operation.type === 'prepare') return api.prepareCustomDomain(organizationId, operation.id)
      if (operation.type === 'retry') return api.advanceCustomDomain(organizationId, operation.id)
      if (operation.type === 'delete') await api.deleteCustomDomain(organizationId, operation.id)
      if (operation.type === 'bind') await api.bindDomain(organizationId, operation.hostname, box.trim(), Number(port))
      if (operation.type === 'unbind') await api.unbindDomain(organizationId, operation.hostname)
    },
    onSuccess: async (result, operation) => {
      if (result) {
        if (operation.type === 'prepare') receivePreparation(result)
        else saveDomain(result)
        // A slow held-domain refresh must not delay the verification result.
        void client.invalidateQueries({ queryKey: queryKeys.domains.list(organizationId) })
        return
      }
      if (operation.type === 'delete') {
        setSelected(null)
        setDeleting(null)
      }
      await refresh()
    },
    onError: () => setPreparing(null),
  })
  const data = query.data
  const canCreate = canManage && data?.enabled && data.subscription !== 'required'
  const domain = data?.domains.find((value) => value.id === selected)
  const waitingForRecords =
    !!domain &&
    preparing?.organizationId === organizationId &&
    preparing.id === domain.id &&
    needsDnsPreparation(domain)
  useEffect(() => {
    if (!waitingForRecords || !open || !canCreate || !domain || action.isPending || create.isPending) return
    const timer = window.setTimeout(
      () => action.mutate({ type: 'prepare', id: domain.id, hostname: domain.hostname }),
      Math.max(3, domain.retryAfter || 3) * 1000,
    )
    return () => window.clearTimeout(timer)
  }, [waitingForRecords, open, canCreate, domain, action.isPending, create.isPending, action.mutate])
  const showHostnameForm =
    !domain || (!domain.confirmed && !domain.ready && domain.phase !== 'superseded' && domain.dnsRecords.length < 3)
  const formHostname = domain?.hostname ?? hostname
  const canRetryHttps = domain?.confirmed && !domain.ready && !!domain.errorCode && domain.phase !== 'superseded'
  const target = held.find((value) => value.hostname === domain?.hostname)?.target
  const run = (type: 'verify' | 'prepare' | 'retry' | 'delete' | 'bind' | 'unbind') => {
    if (!domain) return
    action.mutate(
      { type, id: domain.id, hostname: domain.hostname },
      {
        onSuccess: (result) => {
          if (!result) return
          if (type === 'retry') {
            if (result.errorCode || !result.confirmed || result.phase === 'superseded')
              toast.error('HTTPS setup still needs attention.')
            else if (result.ready) toast.success('HTTPS is ready.')
            else toast.info('HTTPS setup is in progress. You can check back later.')
            return
          }
          if (type !== 'verify') return
          if (!result.confirmed || result.phase === 'superseded') {
            if (result.errorCode)
              toast.error(ERRORS[result.errorCode] ?? 'DNS verification failed. Check the records and retry.')
            else toast.info('DNS verification is still pending. Please try again.')
            return
          }
          const description = result.errorCode
            ? (ERRORS[result.errorCode] ?? 'HTTPS setup needs attention. Reopen this domain to review the error.')
            : result.ready
              ? 'HTTPS is ready. You can now bind a Box port.'
              : result.submissionStatus === 'accepted'
                ? 'HTTPS is being enabled. You can return later to check progress.'
                : result.submissionStatus === 'unknown'
                  ? 'Certificate submission is not yet confirmed. Return later to check progress.'
                  : 'The certificate request has not been submitted. Return later to check progress.'
          toast.success('DNS verification passed.', { description })
          setOpen(false)
        },
      },
    )
  }
  const busy = create.isPending || action.isPending || (waitingForRecords && canCreate)
  const canBind =
    canCreate &&
    domain?.ready &&
    !!box.trim() &&
    Number.isInteger(Number(port)) &&
    Number(port) >= 1 &&
    Number(port) <= 65535 &&
    !busy
  const copyRecord = async (value: string, label: string) => {
    if (await copyToClipboard(value)) toast.success(`${label} copied`)
    else toast.error('Could not copy DNS record. Select the value and copy it manually.')
  }
  if (!canManage) return null
  return (
    <section className="min-h-0 pb-6 text-body" aria-label="Custom domains">
      <div className="resource-toolbar">
        {data && (
          <span className="font-mono text-meta tabular-nums text-muted-foreground">
            {data.domains.filter((item) => item.phase !== 'superseded').length} / 1 custom domains
          </span>
        )}
        <div className="flex-1" />
        <AsciiButton
          variant="primary"
          className="h-11 sm:h-9"
          onClick={() => {
            setSelected(null)
            setHostname('')
            create.reset()
            action.reset()
            setDeleting(null)
            setOpen(true)
          }}
        >
          <Plus className="size-3.5" /> Add custom domain
        </AsciiButton>
      </div>
      {query.isPending && (
        <p role="status" className="py-10 text-muted-foreground">
          Loading custom domains…
        </p>
      )}
      {query.isError && !data && (
        <div role="alert" className="flex items-center gap-3 py-6 text-destructive">
          Unable to load custom domains.
          <AsciiButton onClick={() => void query.refetch()}>Retry</AsciiButton>
        </div>
      )}
      {data && !data.enabled && (
        <p className="mt-4 text-muted-foreground">Custom domains are not enabled on this deployment.</p>
      )}
      {data?.subscription === 'required' && (
        <p role="status" className="mt-4 text-muted-foreground">
          Subscribe to add, bind and access custom domains.
        </p>
      )}
      {data && data.domains.length === 0 && (
        <ResourceEmptyState icon={<Globe className="size-6" />} title="Bring your own domain" />
      )}
      {data && data.domains.length > 0 && (
        <div className="mt-[14px] border-t border-border">
          {data.domains.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={`Manage ${item.hostname}`}
              className="flex w-full flex-wrap items-center gap-4 border-b border-border/60 px-4 py-5 text-left transition-colors hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              onClick={() => {
                setSelected(item.id)
                action.reset()
                setDeleting(null)
                setBox('')
                setOpen(true)
                if (item.confirmed && !item.ready && item.phase !== 'superseded') void query.refetch()
              }}
            >
              <Globe className="size-6 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-all font-mono font-semibold">{item.hostname}</span>
              <DomainStatus domain={item} active={data.subscription === 'active'} />
              <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next)
          }
        }}
      >
        <FormDialogContent
          className={showHostnameForm ? 'sm:max-w-[480px]' : 'sm:max-w-[680px]'}
          showCloseButton={!busy}
        >
          <FormDialogHeader>
            <DialogTitle className="break-all">{domain?.hostname ?? 'Add custom domain'}</DialogTitle>
            <DialogDescription className="mt-2 text-body leading-relaxed">
              {showHostnameForm
                ? 'Use a subdomain you own, such as app.example.com. BoxLite manages HTTPS.'
                : 'Manage DNS, HTTPS and the Box this domain points to.'}
            </DialogDescription>
          </FormDialogHeader>
          <FormDialogBody className="space-y-5">
            {showHostnameForm ? (
              <form
                id="custom-domain-create"
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (canCreate && formHostname.trim() && !busy && !deleting) {
                    if (domain) run('prepare')
                    else create.mutate()
                  }
                }}
              >
                <label className="block text-meta font-medium" htmlFor="custom-hostname">
                  Hostname
                </label>
                <Input
                  id="custom-hostname"
                  aria-label="Custom hostname"
                  className="font-mono"
                  value={formHostname}
                  disabled={busy || !!domain}
                  maxLength={221}
                  placeholder="app.example.com"
                  onChange={(event) => setHostname(event.target.value)}
                />
                {!canCreate && (
                  <p role="status" className="text-warning">
                    An active subscription and an enabled deployment are required to add a domain.
                  </p>
                )}
                {!domain && create.isError && (
                  <p role="alert" className="text-destructive">
                    {create.error.message}
                  </p>
                )}
                {domain?.errorCode && domain.errorCode !== 'dns_configuration_pending' && !busy && (
                  <p role="alert" className="text-muted-foreground">
                    {ERRORS[domain.errorCode] ?? 'Could not get DNS configuration. Please try again.'}
                  </p>
                )}
              </form>
            ) : (
              <>
                <div className="space-y-2" role="status">
                  <DomainStatus domain={domain} active={data?.subscription === 'active'} />
                  <p className="leading-relaxed text-muted-foreground">
                    {domain.phase === 'superseded'
                      ? 'A newer verified application owns this hostname. This configuration is no longer valid.'
                      : domain.ready
                        ? 'HTTPS is ready. Bind a Box port with a public tunnel and inbound access enabled.'
                        : !domain.confirmed
                          ? 'Add all three records below, then click Configured, verify.'
                          : canRetryHttps
                            ? 'DNS verification passed. HTTPS setup needs attention.'
                            : domain.submissionStatus === 'accepted'
                              ? 'DNS verification passed. HTTPS is being enabled. You can leave this page and return later.'
                              : domain.submissionStatus === 'unknown'
                                ? 'Confirming whether the certificate request was accepted. Do not create another configuration.'
                                : 'DNS verification passed, but the certificate request has not been submitted.'}
                  </p>
                  {!domain.ready && domain.phase !== 'superseded' && (
                    <p className="text-meta text-muted-foreground">DNS propagation and HTTPS setup can take time.</p>
                  )}
                </div>
                {domain.errorCode && domain.phase !== 'superseded' && (
                  <p role="alert" className="border-l-2 border-warning pl-3 leading-relaxed">
                    {ERRORS[domain.errorCode] ??
                      `Setup needs attention: ${domain.errorCode}. Retry or contact support.`}
                    {canRetryHttps && (
                      <span className="mt-2 block">
                        If retrying does not help, contact{' '}
                        <a href="mailto:support@boxlite.ai" className="underline underline-offset-4">
                          support@boxlite.ai
                        </a>
                        .
                      </span>
                    )}
                  </p>
                )}
                {domain.ready && (
                  <form
                    id="custom-domain-bind"
                    className="space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (canBind) run('bind')
                    }}
                  >
                    <p className="text-meta text-muted-foreground">
                      Saved target:{' '}
                      <span className="font-mono text-foreground">
                        {target?.type === 'box' ? `${target.box}:${target.port}` : 'Unbound'}
                      </span>
                    </p>
                    <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-3">
                      <label className="space-y-2 text-meta font-medium">
                        Box ID or name
                        <Input
                          className="font-mono"
                          aria-label="Box ID or name"
                          placeholder="my-box"
                          value={box}
                          onChange={(event) => setBox(event.target.value)}
                        />
                      </label>
                      <label className="space-y-2 text-meta font-medium">
                        Port
                        <Input
                          className="font-mono"
                          aria-label="Port"
                          type="number"
                          min="1"
                          max="65535"
                          value={port}
                          onChange={(event) => setPort(event.target.value)}
                        />
                      </label>
                    </div>
                  </form>
                )}
                {domain.dnsRecords.length > 0 && (
                  <details key={domain.id} open={!domain.ready && domain.phase !== 'superseded'} className="group">
                    <summary className="cursor-pointer text-meta font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                      DNS records{' '}
                      <span className="font-normal text-muted-foreground">
                        · Keep these for verification and renewal
                      </span>
                    </summary>
                    <div className="mt-3 divide-y divide-border border border-border">
                      {domain.dnsRecords.map((record) => {
                        const kind =
                          record.type === 'TXT'
                            ? 'ownership'
                            : record.name === domain.hostname
                              ? 'traffic'
                              : 'certificate'
                        const label =
                          kind === 'ownership'
                            ? 'Domain ownership'
                            : kind === 'traffic'
                              ? 'Traffic routing'
                              : 'Certificate authorization'
                        const check = domain.dnsChecks?.find((value) => value.record === kind)
                        return (
                          <div key={record.name} className="space-y-2 px-4 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-meta">
                              <span className="font-medium">{label}</span>
                              <span className="font-mono text-muted-foreground">{record.type}</span>
                            </div>
                            {(['name', 'value'] as const).map((field) => (
                              <div key={field} className="grid grid-cols-[40px_minmax(0,1fr)_28px] items-start gap-2">
                                <span className="pt-1 text-meta text-muted-foreground">
                                  {field === 'name' ? 'Name' : 'Value'}
                                </span>
                                <code className="break-all pt-1 font-mono text-meta leading-relaxed select-text">
                                  {record[field]}
                                </code>
                                <AsciiButton
                                  size="icon"
                                  aria-label={`Copy ${field} for ${label}`}
                                  title={`Copy ${field}`}
                                  onClick={() => void copyRecord(record[field], `DNS ${field}`)}
                                >
                                  <Copy className="size-3.5" />
                                </AsciiButton>
                              </div>
                            ))}
                            {check && (
                              <p
                                role={check.status === 'passed' ? 'status' : 'alert'}
                                className={`text-meta ${check.status === 'passed' ? 'text-muted-foreground' : 'text-warning'}`}
                              >
                                {check.status === 'passed'
                                  ? 'Verified'
                                  : (ERRORS[check.errorCode ?? ''] ?? 'Could not verify this record.')}
                              </p>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </details>
                )}
                <details className="text-meta text-muted-foreground">
                  <summary className="cursor-pointer text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                    DNS help and timing
                  </summary>
                  <div className="mt-3 space-y-3 leading-relaxed">
                    <p>
                      Use DNS-only mode for both CNAME records (gray cloud in Cloudflare) and remove conflicting
                      records. For certificate authorization, copy its exact name, including the _acme-challenge prefix;
                      do not replace the traffic CNAME.
                    </p>
                    <p>
                      If your DNS provider adds the zone suffix automatically, enter only the relative name and check
                      the resulting full name.
                    </p>
                    <p>DNS changes can take minutes to hours.</p>
                    {domain.certificateObservedAt && (
                      <p className="break-words">
                        Certificate: {domain.certificateState ?? 'unknown'} · Observed: {domain.certificateObservedAt} ·
                        Expires: {domain.certificateExpiresAt ?? 'unknown'}
                      </p>
                    )}
                  </div>
                </details>
              </>
            )}
            {domain && deleting === domain.id && (
              <p role="alert" className="border-l-2 border-destructive pl-3 leading-relaxed">
                Delete {domain.hostname}? Access stops and ownership is released. Remove its DNS records afterward.
              </p>
            )}
            {action.isError && (
              <p role="alert" className="text-destructive">
                {action.variables?.type === 'retry'
                  ? 'Could not retry HTTPS setup. Please try again or contact support@boxlite.ai.'
                  : action.error.message}
              </p>
            )}
          </FormDialogBody>
          <FormDialogFooter className="flex-wrap">
            {domain && deleting === domain.id ? (
              <>
                <AsciiButton disabled={busy} onClick={() => setDeleting(null)}>
                  Keep domain
                </AsciiButton>
                <AsciiButton variant="dangerSolid" disabled={busy} onClick={() => run('delete')}>
                  Confirm deletion
                </AsciiButton>
              </>
            ) : showHostnameForm ? (
              <>
                {domain && (
                  <AsciiButton
                    variant="danger"
                    aria-label="Delete configuration"
                    disabled={busy}
                    onClick={() => setDeleting(domain.id)}
                  >
                    Delete
                  </AsciiButton>
                )}
                <AsciiButton disabled={busy} onClick={() => setOpen(false)}>
                  Cancel
                </AsciiButton>
                <AsciiButton
                  variant="primary"
                  type="submit"
                  form="custom-domain-create"
                  disabled={!canCreate || !formHostname.trim() || busy}
                >
                  {busy ? 'Getting DNS configuration…' : 'Get DNS configuration'}
                </AsciiButton>
              </>
            ) : (
              <>
                <AsciiButton
                  variant="danger"
                  aria-label="Delete configuration"
                  disabled={busy}
                  onClick={() => setDeleting(domain.id)}
                >
                  Delete
                </AsciiButton>
                {target && (
                  <AsciiButton disabled={busy} onClick={() => run('unbind')}>
                    Unbind
                  </AsciiButton>
                )}
                <div className="flex-1" />
                {domain.ready ? (
                  <AsciiButton variant="primary" type="submit" form="custom-domain-bind" disabled={!canBind}>
                    Bind
                  </AsciiButton>
                ) : canRetryHttps ? (
                  <AsciiButton variant="primary" disabled={!canCreate || busy} onClick={() => run('retry')}>
                    {action.isPending && action.variables?.type === 'retry' ? 'Retrying…' : 'Retry'}
                  </AsciiButton>
                ) : (
                  !domain.confirmed &&
                  domain.phase !== 'superseded' && (
                    <AsciiButton variant="primary" disabled={!canCreate || busy} onClick={() => run('verify')}>
                      {action.isPending
                        ? action.variables?.type === 'verify'
                          ? 'Verifying DNS, please wait…'
                          : 'Checking progress…'
                        : 'Configured, verify'}
                    </AsciiButton>
                  )
                )}
              </>
            )}
          </FormDialogFooter>
        </FormDialogContent>
      </Dialog>
    </section>
  )
}
