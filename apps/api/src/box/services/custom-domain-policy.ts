/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { BadRequestException } from '@nestjs/common'
import { isIP } from 'node:net'
import { parse } from 'tldts'

export function normalizeCustomHostname(raw: unknown): string {
  const hostname = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\.$/, '') : ''
  const validLabels = hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  const suffix = parse(hostname, { allowPrivateDomains: true })
  if (
    !validLabels ||
    hostname.length > 220 ||
    isIP(hostname) ||
    !suffix.domain ||
    !suffix.subdomain ||
    (!suffix.isIcann && !suffix.isPrivate)
  ) {
    throw new BadRequestException({
      code: 'invalid_custom_domain',
      message: 'Use a public ASCII/Punycode subdomain, at most 220 bytes.',
    })
  }
  return hostname
}

/** Setup readiness only. Callers must independently authorize the current subscription. */
export const CUSTOM_DOMAIN_READY_SQL = `EXISTS (
  SELECT 1 FROM custom_domain_config c
  WHERE c.domain_id = d.id AND c.organization_id = d.organization_id AND c.hostname = d.hostname
    AND c.deleted_at IS NULL AND c.superseded_by IS NULL AND c.phase = 'ready' AND c.confirmed_at IS NOT NULL
)`

export type DomainDnsRecord = { name: string; type: 'TXT' | 'CNAME'; value: string }
export type DomainProviderState = {
  authorization?: string
  certificate?: string
  entry?: string
  operation?: string
  authorizationRecord?: DomainDnsRecord
  certificateSubmitted?: boolean
  certificateState?: string
  progress?: 'preparing_dns' | 'awaiting_dns' | 'certificate_pending' | 'mapping_pending' | 'tls_pending' | 'ready'
}

export type DomainDnsCheck = {
  record: 'ownership' | 'traffic' | 'certificate'
  status: 'passed' | 'failed' | 'unavailable'
  errorCode?: string
}

export type CustomDomainRow = {
  id: string
  organization_id: string
  hostname: string
  domain_id: string | null
  challenge: string
  generation: number
  challenge_expires_at: Date
  phase: 'pending_verification' | 'pending_certificate_dns' | 'provisioning' | 'ready' | 'deleting'
  error_code: string | null
  provider_state: DomainProviderState
  deleted_at: Date | null
  lease_owner: string | null
  confirmed_at: Date | null
  superseded_by: string | null
  cleaned_at: Date | null
  next_check_at: Date
  submission_status: 'not_submitted' | 'unknown' | 'accepted'
  dns_checks: DomainDnsCheck[]
  dns_checked_at: Date | null
  tls_checked_at: Date | null
  certificate_observed_at: Date | null
  certificate_expires_at: Date | null
}

export const CUSTOM_DOMAIN_COLUMNS = 'c.*'
