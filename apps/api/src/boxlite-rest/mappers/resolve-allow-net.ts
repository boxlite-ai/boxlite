/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { promises as dns } from 'dns'
import { Logger } from '@nestjs/common'
import { MAX_NETWORK_ALLOW_LIST_ENTRIES } from '../../box/utils/network-validation.util'

const logger = new Logger('resolveAllowNetHostnames')

const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

// Bound the DNS lookup so a slow resolver can't pin the create call.
// 2s matches the rest of the API's outbound timeouts.
const DNS_LOOKUP_TIMEOUT_MS = 2_000

/**
 * Convert `network.allow_net` hostnames to /32 CIDRs at box-create time so the
 * lower layer can bind egress to concrete IPs instead of trusting a
 * guest-supplied SNI/Host (audit finding #1, REST-side layer; the gvproxy-side
 * SNI↔IP binding is the universal layer). CIDR entries pass through unchanged;
 * bare IPv4 addresses get `/32` appended.
 *
 * Hostnames that don't resolve (NXDOMAIN, timeout, refused) are dropped with a
 * warning rather than failing the whole create call — "any unresolvable hostname
 * rejects the box" is a sharp footgun for callers whose DNS state is transient.
 *
 * Caveat: the resulting /32 list captures the hostname's resolution **at create
 * time**; records that change later are not reflected. The gvproxy-side filter
 * (bound to the guest's live sinkhole resolution) covers the dynamic case.
 */
export async function resolveAllowNetHostnames(allowNet: string[]): Promise<string[]> {
  const result: string[] = []

  for (const raw of allowNet) {
    const entry = raw.trim()
    if (!entry) continue
    if (result.length >= MAX_NETWORK_ALLOW_LIST_ENTRIES) {
      logger.warn(`allow_net cap of ${MAX_NETWORK_ALLOW_LIST_ENTRIES} hit — dropping remaining entries`)
      break
    }

    if (CIDR_RE.test(entry)) {
      result.push(entry)
      continue
    }
    if (IPV4_RE.test(entry)) {
      result.push(`${entry}/32`)
      continue
    }

    // Treat as hostname (incl. wildcard). Resolve to /32 entries.
    try {
      const addrs = await resolveWithTimeout(entry, DNS_LOOKUP_TIMEOUT_MS)
      if (addrs.length === 0) {
        logger.warn(`allow_net hostname "${entry}" resolved to zero A records — dropped`)
        continue
      }
      for (const a of addrs) {
        if (result.length >= MAX_NETWORK_ALLOW_LIST_ENTRIES) {
          logger.warn(`allow_net cap of ${MAX_NETWORK_ALLOW_LIST_ENTRIES} hit while expanding "${entry}" — truncating`)
          break
        }
        result.push(`${a}/32`)
      }
    } catch (err: any) {
      logger.warn(`allow_net hostname "${entry}" resolve failed: ${err?.message ?? err} — dropped`)
    }
  }

  return result
}

async function resolveWithTimeout(hostname: string, timeoutMs: number): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DNS lookup timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([dns.resolve4(hostname), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
