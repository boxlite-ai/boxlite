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
 * Detection uses the hostname, NOT `config.environment`: the dev stage reports
 * `environment: "production"` (it's a production *build* of the dev stage), so
 * that field cannot tell dev from prod. The hostname is the reliable signal.
 * URLs below were verified against the live /api/config endpoints.
 */
export type AppEnvironment = 'local' | 'development' | 'production'

// ⚠️ EDIT HERE — the public REST API base each environment's SDK/CLI should target.
// `local` is intentionally omitted: it falls back to the dashboard's own /api.
const REST_API_URL_BY_ENV: Partial<Record<AppEnvironment, string>> = {
  development: 'https://dev.boxlite.ai/api',
  production: 'https://api.boxlite.ai/api',
}

/** Resolve the current environment from the hostname. */
export function resolveEnvironment(
  hostname: string = typeof window !== 'undefined' ? window.location.hostname : '',
): AppEnvironment {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'local'
  if (hostname === 'dev.boxlite.ai' || hostname.includes('.dev.')) return 'development'
  return 'production'
}

/** The public REST API URL to show in SDK/CLI snippets for the current environment. */
export function getRestApiUrl(fallback: string, hostname?: string): string {
  return REST_API_URL_BY_ENV[resolveEnvironment(hostname)] ?? fallback
}
