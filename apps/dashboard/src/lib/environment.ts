/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Frontend environment + public API URL resolution.
 *
 * Short-term shim: the dashboard pins the public REST API URL per environment
 * here, on the frontend, so the Quickstart snippets point at the right backend
 * without a backend change. The long-term fix is to read a server-provided
 * `restApiUrl` from /api/config; until then this file is the single place to edit.
 *
 * Detection uses the OIDC issuer first, then the hostname. `config.environment`
 * cannot distinguish dev from prod because the dev stage reports
 * `environment: "production"` (it's a production build of the dev stage). The
 * issuer keeps local dashboard + dev/prod API proxy runs honest, where the
 * browser hostname is just `localhost`.
 */
export type AppEnvironment = 'local' | 'development' | 'production'

// ⚠️ EDIT HERE — the public REST API base each environment's SDK/CLI should target.
// `local` is intentionally omitted: it falls back to the dashboard's own /api.
const REST_API_URL_BY_ENV: Partial<Record<AppEnvironment, string>> = {
  development: 'https://dev.boxlite.ai/api',
  production: 'https://api.boxlite.ai/api',
}

/** Resolve the current environment from the API issuer and browser hostname. */
export function resolveEnvironment(
  hostname: string = typeof window !== 'undefined' ? window.location.hostname : '',
  oidcIssuer = '',
): AppEnvironment {
  const issuer = oidcIssuer.toLowerCase()
  if (issuer.includes('auth.dev.boxlite.ai') || issuer.includes('.dev.')) return 'development'
  if (issuer.includes('auth.boxlite.ai')) return 'production'

  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'local'
  if (hostname === 'dev.boxlite.ai' || hostname.includes('.dev.')) return 'development'
  return 'production'
}

/** The public REST API URL to show in SDK/CLI snippets for the current environment. */
export function getRestApiUrl(fallback: string, hostname?: string, oidcIssuer?: string): string {
  return REST_API_URL_BY_ENV[resolveEnvironment(hostname, oidcIssuer)] ?? fallback
}
