/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

const API_PREFIX = '/api'
const PUBLIC_STATIC_PATHS = new Set(['/runner-amd64'])

export function parseUnprefixedApiHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
}

export function normalizeRequestHost(host: string | undefined): string {
  return (host ?? '').split(':')[0].trim().toLowerCase()
}

export function shouldRewriteUnprefixedApiUrl(
  host: string | undefined,
  url: string | undefined,
  allowedHosts: string[],
) {
  if (!url || !url.startsWith('/')) return false

  const normalizedHost = normalizeRequestHost(host)
  if (!normalizedHost || !allowedHosts.includes(normalizedHost)) return false

  const pathname = url.split('?')[0]
  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) return false
  if (pathname === '/' || PUBLIC_STATIC_PATHS.has(pathname) || pathname.startsWith('/assets/')) return false

  return true
}

export function rewriteUnprefixedApiUrlForHost(
  host: string | undefined,
  url: string | undefined,
  allowedHosts: string[],
): string | undefined {
  if (!shouldRewriteUnprefixedApiUrl(host, url, allowedHosts)) return url
  return `${API_PREFIX}${url}`
}
