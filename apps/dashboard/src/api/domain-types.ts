/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

/** Spec-first /v1/domains contract, outside the generated Nest client. */
export interface HeldDomain {
  hostname: string
  url: string
  target: { type: 'box'; box: string; port: number } | { type: 'app'; app: string; environment?: string } | null
}

export interface DomainList {
  domains: HeldDomain[]
  limit: number
  used: number
  remaining: number
  min_length: number
  domain_suffix: string | null
}
