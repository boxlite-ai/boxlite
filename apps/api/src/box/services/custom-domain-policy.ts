/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { BadRequestException } from '@nestjs/common'
import { isIP } from 'node:net'
import { parse } from 'tldts'

export function normalizeCustomHostname(raw: unknown, reserved: string[]): string {
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
  if (reserved.filter(Boolean).some((name) => hostname === name || hostname.endsWith(`.${name}`))) {
    throw new BadRequestException({
      code: 'reserved_domain',
      message: 'This hostname belongs to a reserved platform namespace.',
    })
  }
  return hostname
}

/** Alias d is the persisted domain. A custom row alone never grants traffic. */
export const CUSTOM_DOMAIN_READY_SQL = `EXISTS (
  SELECT 1 FROM custom_domain_config c JOIN custom_domain_subscription s ON s.organization_id = c.organization_id
  WHERE c.domain_id = d.id AND c.organization_id = d.organization_id AND c.hostname = d.hostname
    AND c.deleted_at IS NULL AND c.phase = 'ready' AND c.dns_valid_until > now()
    AND c.certificate_valid_until > now() AND s.eligible = true AND s.valid_until > now()
)`

export type DomainDnsRecord = { name: string; type: 'TXT' | 'CNAME'; value: string }
export type DomainProviderState = {
  authorization?: string
  certificate?: string
  entry?: string
  operation?: string
  authorizationRecord?: DomainDnsRecord
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
  dns_valid: boolean
  certificate_valid: boolean
}

export const CUSTOM_DOMAIN_COLUMNS = `c.*, c.dns_valid_until > now() AS dns_valid,
  c.certificate_valid_until > now() AS certificate_valid`
