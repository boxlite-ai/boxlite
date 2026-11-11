/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import type { CustomDomain, HeldDomain } from '@/api/domain-types'

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
  dns_configuration_pending: 'Continue getting DNS configuration before verifying.',
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
  certificate_provisioning_failed:
    'Google stopped issuing this certificate. Check the certificate CNAME and allow pki.goog in any CAA restrictions. Continuing setup retries after DNS passes; replacements are spaced at least one hour apart. Requesting a check does not skip this delay.',
  certificate_renewal_failed: 'Google reports a renewal failure. Contact support; the last working setup is retained.',
  provider_request_rejected:
    'The certificate request was rejected. Correct the reported configuration or contact support before retrying.',
  https_not_ready: 'The certificate is not yet available at every entry point. Return here to continue checking.',
  subscription_required: 'An active organization subscription is required. Your configuration is retained.',
  subscription_not_ready:
    'Subscription eligibility could not be confirmed. Access pauses when the current grant expires.',
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
            ? 'Waiting for HTTPS'
            : domain.dnsRecords.length
              ? 'Waiting for DNS verification'
              : 'Getting DNS configuration'
  return (
    <StatusIndicator
      label={label}
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
  const [visible, setVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  const [hostname, setHostname] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [box, setBox] = useState('')
  const [port, setPort] = useState('3000')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [preparingFor, setPreparingFor] = useState<string | null>(null)
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.listCustomDomains(organizationId),
    enabled: canManage,
  })
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: key }),
      client.invalidateQueries({ queryKey: queryKeys.domains.list(organizationId) }),
    ])
  }
  const create = useMutation({
    mutationFn: () => api.createCustomDomain(organizationId, hostname),
    onSuccess: async (domain) => {
      setSelected(domain.id)
      setPreparingFor(domain.dnsRecords.length ? null : domain.id)
      await refresh()
    },
  })
  const action = useMutation({
    mutationFn: async (operation: {
      type: 'verify' | 'prepare' | 'advance' | 'delete' | 'bind' | 'unbind'
      id: string
      hostname: string
    }) => {
      if (operation.type === 'verify') await api.verifyCustomDomain(organizationId, operation.id)
      if (operation.type === 'prepare') await api.prepareCustomDomain(organizationId, operation.id)
      if (operation.type === 'advance') await api.advanceCustomDomain(organizationId, operation.id)
      if (operation.type === 'delete') await api.deleteCustomDomain(organizationId, operation.id)
      if (operation.type === 'bind') await api.bindDomain(organizationId, operation.hostname, box.trim(), Number(port))
      if (operation.type === 'unbind') await api.unbindDomain(organizationId, operation.hostname)
    },
    onSuccess: async (_, operation) => {
      if (operation.type === 'delete') {
        setSelected(null)
        setDeleting(null)
      }
      await refresh()
    },
  })
  const data = query.data
  const canCreate = canManage && data?.enabled && data.subscription !== 'required'
  const domain = data?.domains.find((value) => value.id === selected)
  const target = held.find((value) => value.hostname === domain?.hostname)?.target
  const run = (type: 'verify' | 'prepare' | 'advance' | 'delete' | 'bind' | 'unbind') => {
    if (type === 'prepare' && domain) setPreparingFor(domain.id)
    if (domain) action.mutate({ type, id: domain.id, hostname: domain.hostname })
  }
  useEffect(() => {
    if (!visible || !open || !domain || !canCreate || action.isPending || domain.ready || domain.phase === 'superseded')
      return
    const type = domain.confirmed
      ? 'advance'
      : preparingFor === domain.id && !domain.dnsRecords.length
        ? 'prepare'
        : null
    if (!type) return
    const timer = setTimeout(
      () => {
        if (document.visibilityState === 'visible') action.mutate({ type, id: domain.id, hostname: domain.hostname })
      },
      Math.max(10, domain.retryAfter || 10) * 1000,
    )
    return () => clearTimeout(timer)
  }, [visible, open, domain, canCreate, action.isPending, preparingFor])
  const busy = create.isPending || action.isPending
  const canBind =
    canCreate &&
    domain?.ready &&
    !!box.trim() &&
    Number.isInteger(Number(port)) &&
    Number(port) >= 1 &&
    Number(port) <= 65535 &&
    !busy
  const stepLabel = !domain?.dnsRecords.length
    ? 'Continue getting DNS configuration'
    : domain.confirmed
      ? 'Continue HTTPS setup'
      : 'Configured, verify'
  const copyRecord = async (value: string, label: string) => {
    if (await copyToClipboard(value)) toast.success(`${label} copied`)
    else toast.error('Could not copy DNS record. Select the value and copy it manually.')
  }
  if (!canManage) return null
  return (
    <section className="min-h-0 pb-6 text-body" aria-label="Custom domains">
      <div className="resource-toolbar">
        <p className="text-meta text-muted-foreground">
          One custom domain per organization · Active subscription required
        </p>
        <div className="flex-1" />
        <AsciiButton
          variant="primary"
          className="h-11 sm:h-9"
          onClick={() => {
            setSelected(null)
            setHostname('')
            create.reset()
            action.reset()
            setPreparingFor(null)
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
      {query.isError && (
        <div role="alert" className="flex items-center gap-3 py-6 text-destructive">
          Unable to load custom domains.
          <AsciiButton onClick={() => void query.refetch()}>Retry</AsciiButton>
        </div>
      )}
      {data && !data.enabled && (
        <p className="mt-4 text-muted-foreground">Custom domains are not enabled on this deployment.</p>
      )}
      {data && data.subscription !== 'active' && (
        <p role="status" className="mt-4 text-muted-foreground">
          {data.subscription === 'required'
            ? 'Subscribe to add, bind and access custom domains.'
            : 'Subscription eligibility is temporarily unavailable.'}{' '}
          Existing configurations can still be viewed, unbound or deleted.
        </p>
      )}
      {data && data.domains.length === 0 && (
        <ResourceEmptyState
          icon={<Globe className="size-6" />}
          title="Bring your own domain"
          description="Connect a subdomain you own. Get all three DNS records, configure them once, then verify to enable HTTPS."
        />
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
                setPreparingFor(null)
                setDeleting(null)
                setBox('')
                setOpen(true)
              }}
            >
              <Globe className="size-6 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-all font-mono font-semibold">{item.hostname}</span>
              <DomainStatus domain={item} active={data.subscription === 'active'} />
              <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            </button>
          ))}
          <p className="mt-3 text-meta text-muted-foreground">
            Pending setups count toward the limit. Delete a configuration before adding another hostname; platform
            domain allowance is separate.
          </p>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next)
            if (!next) setPreparingFor(null)
          }
        }}
      >
        <FormDialogContent className={domain ? 'sm:max-w-[680px]' : 'sm:max-w-[480px]'} showCloseButton={!busy}>
          <FormDialogHeader>
            <DialogTitle className="break-all">{domain?.hostname ?? 'Add custom domain'}</DialogTitle>
            <DialogDescription className="mt-2 text-body leading-relaxed">
              {domain
                ? 'Manage DNS, HTTPS and the Box this domain points to.'
                : 'Use a subdomain you own, such as app.example.com. BoxLite manages HTTPS.'}
            </DialogDescription>
          </FormDialogHeader>
          <FormDialogBody className="space-y-5">
            {!domain ? (
              <form
                id="custom-domain-create"
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (canCreate && hostname.trim() && !busy) create.mutate()
                }}
              >
                <label className="block text-meta font-medium" htmlFor="custom-hostname">
                  Hostname
                </label>
                <Input
                  id="custom-hostname"
                  aria-label="Custom hostname"
                  className="font-mono"
                  value={hostname}
                  maxLength={221}
                  placeholder="app.example.com"
                  onChange={(event) => setHostname(event.target.value)}
                />
                <p className="text-body leading-relaxed text-muted-foreground">
                  Get all three DNS records, add them at your DNS provider, then return to verify. Apex domains and
                  wildcards are not supported.
                </p>
                <p className="text-meta leading-relaxed text-muted-foreground">
                  One domain per organization, including pending setups. Delete the existing configuration before adding
                  another.
                </p>
                {!canCreate && (
                  <p role="status" className="text-warning">
                    An active subscription and an enabled deployment are required to add a domain.
                  </p>
                )}
                {create.isError && (
                  <p role="alert" className="text-destructive">
                    {create.error.message}
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
                        : !domain.dnsRecords.length
                          ? 'Getting all three DNS records. You can continue preparation if it takes longer.'
                          : !domain.confirmed
                            ? 'Add all three records below, then click Configured, verify. DNS is not checked until you confirm.'
                            : domain.submissionStatus === 'accepted'
                              ? 'DNS verification passed. HTTPS is being enabled. You can leave this page and return later.'
                              : domain.submissionStatus === 'unknown'
                                ? 'Confirming whether the certificate request was accepted. Do not create another configuration.'
                                : 'DNS verification passed, but the certificate request has not been submitted.'}
                  </p>
                  {!domain.ready && domain.phase !== 'superseded' && (
                    <p className="text-meta text-muted-foreground">
                      DNS propagation and HTTPS setup can take time; returning does not guarantee immediate readiness.
                    </p>
                  )}
                </div>
                {domain.errorCode && domain.phase !== 'superseded' && (
                  <p role="alert" className="border-l-2 border-warning pl-3 leading-relaxed">
                    {ERRORS[domain.errorCode] ??
                      `Setup needs attention: ${domain.errorCode}. Retry or contact support.`}
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
                {!domain.confirmed && domain.phase !== 'superseded' && (
                  <p className="text-meta leading-relaxed text-muted-foreground">
                    Successful verification makes this the only valid application for the hostname and disconnects any
                    previous organization’s target.
                  </p>
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
                    <p>
                      DNS changes can take minutes to hours. After DNS and load-balancer changes propagate, Google
                      issuance can take up to 60 minutes; mapping deployment can take additional time.
                    </p>
                    <p>
                      While this dialog is visible, confirmed setup advances about every 10 seconds, subject to retry
                      delays. After you leave, Google continues issuance; the API checks at startup and every minute
                      while running. If the API is stopped or paused, checks resume when it runs again.
                    </p>
                    {domain.certificateObservedAt && (
                      <p className="break-words">
                        Certificate: {domain.certificateState ?? 'unknown'} · Observed: {domain.certificateObservedAt} ·
                        Expires: {domain.certificateExpiresAt ?? 'unknown'}
                      </p>
                    )}
                  </div>
                </details>
                {deleting === domain.id && (
                  <p role="alert" className="border-l-2 border-destructive pl-3 leading-relaxed">
                    Delete {domain.hostname}? Access stops and ownership is released. Remove its DNS records afterward.
                  </p>
                )}
                {action.isError && (
                  <p role="alert" className="text-destructive">
                    {action.error.message}
                  </p>
                )}
              </>
            )}
          </FormDialogBody>
          <FormDialogFooter className="flex-wrap">
            {!domain ? (
              <>
                <AsciiButton disabled={busy} onClick={() => setOpen(false)}>
                  Cancel
                </AsciiButton>
                <AsciiButton
                  variant="primary"
                  type="submit"
                  form="custom-domain-create"
                  disabled={!canCreate || !hostname.trim() || busy}
                >
                  {create.isPending ? 'Getting DNS configuration…' : 'Get DNS configuration'}
                </AsciiButton>
              </>
            ) : deleting === domain.id ? (
              <>
                <AsciiButton disabled={busy} onClick={() => setDeleting(null)}>
                  Keep domain
                </AsciiButton>
                <AsciiButton variant="dangerSolid" disabled={busy} onClick={() => run('delete')}>
                  Confirm deletion
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
                ) : (
                  domain.phase !== 'superseded' && (
                    <AsciiButton
                      variant="primary"
                      disabled={!canCreate || busy}
                      onClick={() =>
                        run(!domain.dnsRecords.length ? 'prepare' : domain.confirmed ? 'advance' : 'verify')
                      }
                    >
                      {action.isPending
                        ? action.variables?.type === 'verify'
                          ? 'Verifying DNS, please wait…'
                          : 'Checking progress…'
                        : stepLabel}
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
