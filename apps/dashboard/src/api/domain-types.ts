/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

/** Spec-first /v1/domains contract, outside the generated Nest client. */
export interface HeldDomain {
  hostname: string
  url: string
  target: { type: 'box'; box: string; port: number } | { type: 'app'; app: string } | null
}

export interface DomainList {
  domains: HeldDomain[]
  limit: number
  used: number
  remaining: number
  min_length: number
  domain_suffix: string | null
}

export interface CustomDomain {
  id: string
  hostname: string
  phase: 'pending_verification' | 'pending_certificate_dns' | 'provisioning' | 'ready'
  ready: boolean
  errorCode: string | null
  challengeExpiresAt: string | null
  dnsRecords: { name: string; type: 'CNAME' | 'TXT'; value: string }[]
}
export interface CustomDomainList {
  enabled: boolean
  subscription: 'active' | 'required' | 'unavailable'
  domains: CustomDomain[]
}
