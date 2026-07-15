/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Cache-Control policy for the dashboard SPA static files.
 *
 * Vite emits content-hashed build assets (e.g. /assets/index-C8CfaZCN.js). The
 * filename changes on every build, so those files are immutable and safe to
 * cache forever — this is what stops the browser (and CloudFront) from
 * re-downloading the ~600KB bundle on every Auth0 callback / repeat visit.
 *
 * The HTML shell must NOT be cached long-term: it is the only file that points
 * at the current hashed bundle, so caching it would pin a client to a stale
 * deploy. Everything else falls back to revalidate-always.
 */
export function dashboardStaticCacheControl(filePath: string): string {
  if (/\.html?$/i.test(filePath)) {
    return 'no-cache'
  }
  if (filePath.includes('/assets/')) {
    return 'public, max-age=31536000, immutable'
  }
  return 'public, max-age=0, must-revalidate'
}

/**
 * `setHeaders` hook for @nestjs/serve-static (express.static). Applies the
 * content-addressed cache policy above per served file.
 */
export function setDashboardStaticHeaders(
  res: { setHeader(name: string, value: string): void },
  filePath: string,
): void {
  res.setHeader('Cache-Control', dashboardStaticCacheControl(filePath))
}
