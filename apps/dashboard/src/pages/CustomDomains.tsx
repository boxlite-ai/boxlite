/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApi } from '@/hooks/useApi'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { HeldDomain } from '@/api/domain-types'

const BUTTON = 'rounded border border-border px-3 py-2 text-xs disabled:opacity-40 disabled:cursor-not-allowed'
const INPUT = 'w-full rounded border border-border bg-background px-3 py-2 text-sm'
const PHASES = {
  pending_verification: 'Waiting for DNS verification',
  pending_certificate_dns: 'Waiting for certificate DNS',
  provisioning: 'Waiting for HTTPS',
  ready: 'Ready',
  superseded: 'Replaced by a newer verified application',
}
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
  if (!canManage) return null
  return (
    <section className="mt-8 space-y-4 pb-8" aria-label="Custom domains">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Custom domains</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Use one custom domain per organization with an active subscription, including pending setups. Delete the
            configuration before adding another hostname. Platform domain allowance is separate.
          </p>
        </div>
        <button
          className={BUTTON}
          onClick={() => {
            setSelected(null)
            setHostname('')
            create.reset()
            action.reset()
            setPreparingFor(null)
            setOpen(true)
          }}
        >
          Add custom domain
        </button>
      </div>
      {query.isPending && <p role="status">Loading custom domains…</p>}
      {query.isError && (
        <p role="alert">
          Unable to load custom domains.{' '}
          <button className={BUTTON} onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      )}
      {data && !data.enabled && <p>Custom domains are not enabled on this deployment.</p>}
      {data && data.subscription !== 'active' && (
        <p role="status">
          {data.subscription === 'required'
            ? 'Subscribe to add, bind and access custom domains.'
            : 'Subscription eligibility is temporarily unavailable.'}{' '}
          Existing configurations can still be viewed, unbound or deleted.
        </p>
      )}
      {data?.domains.map((item) => (
        <button
          key={item.id}
          className="flex w-full justify-between gap-4 rounded border border-border p-4 text-left"
          onClick={() => {
            setSelected(item.id)
            action.reset()
            setPreparingFor(null)
            setDeleting(null)
            setBox('')
            setOpen(true)
          }}
        >
          <span className="break-all font-mono text-sm">{item.hostname}</span>
          <span className="text-xs">
            {item.ready && data.subscription === 'active'
              ? 'Ready'
              : item.errorCode
                ? 'Needs attention'
                : item.phase === 'ready'
                  ? 'Setup completed'
                  : PHASES[item.phase]}
          </span>
        </button>
      ))}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!create.isPending && !action.isPending) {
            setOpen(next)
            if (!next) setPreparingFor(null)
          }
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{domain?.hostname ?? 'Set up your own domain'}</DialogTitle>
            <DialogDescription>
              Add DNS records at your DNS provider. BoxLite manages HTTPS after verification.
            </DialogDescription>
          </DialogHeader>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Use a public subdomain, such as app.example.com; apex domains and wildcards are not supported.</li>
            <li>
              Get all three DNS records, then add the traffic CNAME, ownership TXT and certificate CNAME exactly as
              shown. Use DNS-only mode and remove conflicting records.
            </li>
            <li>
              Click Configured, verify after adding all records. For certificate authorization, use its exact name,
              including the _acme-challenge prefix; do not replace the traffic CNAME.
            </li>
            <li>
              Wait for Ready in this dialog or the domain list, then bind a Box port. The port must also have a public
              tunnel and inbound access enabled.
            </li>
          </ol>
          {!domain ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (canCreate && hostname.trim()) create.mutate()
              }}
            >
              <label className="block text-sm">
                Hostname
                <input
                  aria-label="Custom hostname"
                  className={`${INPUT} mt-2`}
                  value={hostname}
                  maxLength={221}
                  placeholder="app.example.com"
                  onChange={(event) => setHostname(event.target.value)}
                />
              </label>
              <button className={BUTTON} disabled={!canCreate || !hostname.trim() || create.isPending}>
                Get DNS configuration
              </button>
              {!canCreate && (
                <p className="text-sm">
                  An active subscription and an enabled deployment are required to add a domain.
                </p>
              )}
              {create.isError && <p role="alert">{create.error.message}</p>}
            </form>
          ) : (
            <div className="space-y-4">
              <p role="status">
                {domain.ready && data?.subscription === 'active'
                  ? 'Ready to bind'
                  : domain.phase === 'ready'
                    ? 'Setup completed'
                    : PHASES[domain.phase]}
              </p>
              {!domain.ready && domain.phase !== 'superseded' && (
                <div role="status" className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    {!domain.dnsRecords.length
                      ? 'Getting all three DNS records. You can continue preparation if it takes longer.'
                      : !domain.confirmed
                        ? 'Configure all three records, then click Configured, verify. DNS is not checked until you confirm.'
                        : domain.submissionStatus === 'accepted'
                          ? 'DNS verification passed. HTTPS is being enabled. You can leave this page and return later.'
                          : domain.submissionStatus === 'unknown'
                            ? 'Confirming whether the certificate request was accepted. Do not create another configuration.'
                            : 'DNS verification passed, but the certificate request has not been submitted.'}
                  </p>
                  <p>
                    DNS changes can take minutes to hours. After DNS and load-balancer changes propagate, Google
                    issuance can take up to 60 minutes; mapping deployment can take additional time.
                  </p>
                  <p>
                    While this dialog is visible, confirmed setup advances about every 10 seconds, subject to retry
                    delays. After you leave, Google continues issuance; the API checks confirmed setup at startup and
                    every minute while running. If the API is stopped or paused, checks resume when it runs again.
                    Returning does not guarantee immediate readiness.
                  </p>
                  <p>Progress: {domain.progress?.replaceAll('_', ' ')}</p>
                </div>
              )}
              {domain.errorCode && (
                <p role="alert">
                  {ERRORS[domain.errorCode] ?? `Setup needs attention: ${domain.errorCode}. Retry or contact support.`}
                </p>
              )}
              {domain.dnsRecords.map((record) => (
                <div key={record.name} className="space-y-1 rounded border border-border p-3 text-xs">
                  <div className="font-semibold">
                    {record.type === 'TXT'
                      ? 'Domain ownership'
                      : record.name === domain.hostname
                        ? 'Traffic routing'
                        : 'Certificate authorization'}{' '}
                    · {record.type}
                  </div>
                  <div className="break-all font-mono">Name: {record.name}</div>
                  <div className="break-all font-mono">Value: {record.value}</div>
                  <div className="flex gap-2">
                    <button className={BUTTON} onClick={() => void navigator.clipboard.writeText(record.name)}>
                      Copy name
                    </button>
                    <button className={BUTTON} onClick={() => void navigator.clipboard.writeText(record.value)}>
                      Copy value
                    </button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Keep all records for verification and certificate renewal. In Cloudflare, use DNS only (gray cloud) for
                both CNAME records. If your DNS provider adds the zone suffix automatically, enter only the relative
                name and check that the full name matches the one shown above.
              </p>
              {domain.dnsChecks?.map((check) => (
                <p key={check.record} role={check.status === 'passed' ? 'status' : 'alert'} className="text-sm">
                  {check.record}:{' '}
                  {check.status === 'passed'
                    ? 'Verified'
                    : (ERRORS[check.errorCode ?? ''] ?? 'Could not verify this record.')}
                </p>
              ))}
              {!domain.confirmed && domain.phase !== 'superseded' && (
                <p className="text-sm">
                  Successful verification makes this the only valid application for the hostname and disconnects any
                  previous organization’s target.
                </p>
              )}
              <button
                className={BUTTON}
                disabled={!canCreate || action.isPending || domain.ready || domain.phase === 'superseded'}
                onClick={() => run(!domain.dnsRecords.length ? 'prepare' : domain.confirmed ? 'advance' : 'verify')}
              >
                {action.isPending
                  ? action.variables?.type === 'verify'
                    ? 'Verifying DNS, please wait…'
                    : 'Checking progress…'
                  : !domain.dnsRecords.length
                    ? 'Continue getting DNS configuration'
                    : domain.confirmed
                      ? 'Continue HTTPS setup'
                      : 'Configured, verify'}
              </button>
              {domain.certificateObservedAt && (
                <p className="text-xs text-muted-foreground">
                  Certificate: {domain.certificateState ?? 'unknown'} · Observed: {domain.certificateObservedAt} ·
                  Expires: {domain.certificateExpiresAt ?? 'unknown'}
                </p>
              )}
              <p className="text-sm">
                Saved target: {target?.type === 'box' ? `${target.box}:${target.port}` : 'Unbound'}
              </p>
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  run('bind')
                }}
              >
                <input
                  className={`${INPUT} flex-1`}
                  aria-label="Box ID or name"
                  placeholder="Box ID or name"
                  value={box}
                  onChange={(event) => setBox(event.target.value)}
                />
                <input
                  className={`${INPUT} max-w-28`}
                  aria-label="Port"
                  type="number"
                  min="1"
                  max="65535"
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                />
                <button
                  className={BUTTON}
                  disabled={
                    !canCreate ||
                    !domain.ready ||
                    !box.trim() ||
                    !Number.isInteger(Number(port)) ||
                    Number(port) < 1 ||
                    Number(port) > 65535 ||
                    action.isPending
                  }
                >
                  Bind
                </button>
              </form>
              <div className="flex gap-2">
                <button className={BUTTON} disabled={!target || action.isPending} onClick={() => run('unbind')}>
                  Unbind
                </button>
                <button className={BUTTON} disabled={action.isPending} onClick={() => setDeleting(domain.id)}>
                  Delete configuration
                </button>
              </div>
              {deleting === domain.id && (
                <div role="alert" className="space-y-2 rounded border border-destructive p-3 text-sm">
                  <p>
                    Delete {domain.hostname}? Access stops and ownership is released. Remove its DNS records afterward.
                  </p>
                  <button className={BUTTON} disabled={action.isPending} onClick={() => run('delete')}>
                    Confirm deletion
                  </button>
                  <button className={`${BUTTON} ml-2`} onClick={() => setDeleting(null)}>
                    Keep domain
                  </button>
                </div>
              )}
              {action.isError && <p role="alert">{action.error.message}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
