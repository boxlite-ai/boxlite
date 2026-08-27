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
 * deploy. Auth0 branding assets also carry content hashes in their filenames,
 * so they share the immutable policy without depending on Vite's /assets path.
 * Everything else falls back to revalidate-always.
 */
function isAuth0BrandingAsset(filePath: string): boolean {
  return /[\\/]auth0[\\/]/.test(filePath)
}

export function dashboardStaticCacheControl(filePath: string): string {
  if (/\.html?$/i.test(filePath)) {
    return 'no-cache'
  }
  if (filePath.includes('/assets/') || isAuth0BrandingAsset(filePath)) {
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
  if (isAuth0BrandingAsset(filePath)) {
    // Auth0 hosts the HTML, so these browser requests are cross-origin. The
    // files are public, immutable brand assets and contain no user data.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('X-Content-Type-Options', 'nosniff')
  }
}
