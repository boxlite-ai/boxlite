/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import React, { useState } from 'react'
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
}
const ERRORS: Record<string, string> = {
  ownership_txt_mismatch: 'The TXT record does not match this configuration. Copy the current value below.',
  traffic_cname_mismatch: 'Point the traffic CNAME to the exact platform endpoint below.',
  traffic_address_mismatch:
    'Traffic resolves to another address. Disable CDN proxying and remove conflicting A/AAAA records.',
  dns_record_missing: 'A DNS record is missing. Check the names and allow time for DNS propagation.',
  dns_unavailable: 'DNS could not be checked. The background check will retry.',
  certificate_dns_mismatch:
    'The certificate authorization CNAME is missing or does not match. Copy its exact name and value below; do not replace the traffic CNAME.',
  challenge_expired: 'This challenge expired. Add the same hostname again to obtain a new TXT value.',
  domain_already_owned: 'This hostname is already held by another organization. Release it there before retrying.',
  provider_capacity_exhausted:
    'The HTTPS service has reached capacity. Contact support; platform domain allowance is separate.',
  provider_permission_denied: 'The HTTPS service needs platform attention. Contact support.',
  provider_unavailable: 'The HTTPS service is temporarily unavailable. Checks will retry.',
  provider_resource_conflict: 'The HTTPS configuration needs platform attention. Contact support.',
  provider_invalid_response:
    'The HTTPS service returned an unexpected response. Contact support if checks keep failing.',
  certificate_provisioning_failed:
    'Google stopped issuing this certificate. Check the certificate CNAME and allow pki.goog in any CAA restrictions. BoxLite retries automatically after DNS passes; replacements are spaced at least one hour apart. Requesting a check does not skip this delay.',
  https_not_ready: 'The certificate is not yet available at every entry point. Checks will retry.',
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
  const [hostname, setHostname] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [box, setBox] = useState('')
  const [port, setPort] = useState('3000')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [checkRequestedFor, setCheckRequestedFor] = useState<string | null>(null)
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.listCustomDomains(organizationId),
    enabled: canManage,
    refetchInterval: 10_000,
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
      await refresh()
    },
  })
  const action = useMutation({
    mutationFn: async (operation: { type: 'verify' | 'delete' | 'bind' | 'unbind'; id: string; hostname: string }) => {
      if (operation.type === 'verify') await api.verifyCustomDomain(organizationId, operation.id)
      if (operation.type === 'delete') await api.deleteCustomDomain(organizationId, operation.id)
      if (operation.type === 'bind') await api.bindDomain(organizationId, operation.hostname, box.trim(), Number(port))
      if (operation.type === 'unbind') await api.unbindDomain(organizationId, operation.hostname)
    },
    onSuccess: async (_, operation) => {
      if (operation.type === 'verify') setCheckRequestedFor(operation.id)
      if (operation.type === 'delete') {
        setSelected(null)
        setDeleting(null)
      }
      await refresh()
    },
  })
  const data = query.data
  const canCreate = canManage && data?.enabled && data.subscription === 'active'
  const domain = data?.domains.find((value) => value.id === selected)
  const target = held.find((value) => value.hostname === domain?.hostname)?.target
  const certificateRecord = domain?.dnsRecords.find(
    (record) => record.type === 'CNAME' && record.name !== domain.hostname,
  )
  const run = (type: 'verify' | 'delete' | 'bind' | 'unbind') => {
    if (type === 'verify') setCheckRequestedFor(null)
    if (domain) action.mutate({ type, id: domain.id, hostname: domain.hostname })
  }
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
            setCheckRequestedFor(null)
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
            setCheckRequestedFor(null)
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
                  ? 'Awaiting renewed verification'
                  : PHASES[item.phase]}
          </span>
        </button>
      ))}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!create.isPending && !action.isPending) setOpen(next)
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
              Add the traffic CNAME and ownership TXT exactly as shown. Use DNS-only mode and remove conflicting
              records.
            </li>
            <li>
              Click Check DNS / retry, then add the separate certificate authorization CNAME when it appears. Use its
              exact name, including the _acme-challenge prefix; do not replace the traffic CNAME.
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
                Get DNS records
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
                    ? 'Awaiting renewed verification'
                    : PHASES[domain.phase]}
              </p>
              {!domain.ready && canCreate && (
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    {domain.phase === 'pending_verification'
                      ? 'Add the traffic CNAME and ownership TXT first. Once public DNS matches, the certificate authorization record will appear here.'
                      : domain.phase === 'pending_certificate_dns'
                        ? certificateRecord
                          ? 'Add the certificate authorization CNAME below. BoxLite checks that exact record before requesting HTTPS.'
                          : 'BoxLite is preparing your certificate authorization record. Wait for the additional CNAME to appear here.'
                        : domain.errorCode === 'https_not_ready'
                          ? 'The certificate is being checked at every HTTPS entry point. Binding stays unavailable until all checks pass.'
                          : 'Google is issuing or deploying your HTTPS certificate. Binding stays unavailable until HTTPS checks pass.'}
                  </p>
                  <p>
                    DNS changes can take minutes to hours to propagate. After DNS and load-balancer changes propagate,
                    Google certificate issuance can take up to 60 minutes; HTTPS deployment can take additional time.
                  </p>
                  <p>
                    This status refreshes every 10 seconds. You can close this dialog; background checks continue. If
                    there is no progress after an hour with DNS fully propagated, check the records and any CAA
                    restrictions, or contact support.
                  </p>
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
              <button className={BUTTON} disabled={!canCreate || action.isPending} onClick={() => run('verify')}>
                {action.isPending && action.variables?.type === 'verify' ? 'Requesting check…' : 'Check DNS / retry'}
              </button>
              {checkRequestedFor === domain.id && (
                <p role="status" className="text-sm">
                  Check requested. This is not a confirmation that DNS or HTTPS is ready. Background checks will update
                  the status here; provider retry delays still apply.
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
