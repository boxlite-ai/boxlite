/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import * as ipaddr from 'ipaddr.js'

export function registrationRateLimitConfig(env: NodeJS.ProcessEnv = process.env) {
  const positive = (name: string, fallback: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
    return value
  }
  const trustedProxies = env.TRUST_PROXY_CIDRS?.trim()
    ? [...new Set(env.TRUST_PROXY_CIDRS.split(',').map((entry) => entry.trim()))]
    : []
  for (const entry of trustedProxies) {
    try {
      if (entry.includes('/')) {
        const [, prefix] = ipaddr.parseCIDR(entry)
        if (prefix === 0) throw new Error('Unrestricted proxy range')
      } else {
        ipaddr.parse(entry)
      }
    } catch {
      throw new Error('TRUST_PROXY_CIDRS must contain trusted proxy addresses or CIDRs')
    }
  }
  return {
    limit: positive('RATE_LIMIT_REGISTRATION_LIMIT', 10),
    ttl: positive('RATE_LIMIT_REGISTRATION_TTL', 600),
    trustedProxies,
  }
}
