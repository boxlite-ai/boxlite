/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Frontend environment + public API URL resolution.
 *
 * The actual domain values live in @boxlite-ai/domain-contract so dashboard,
 * SST, API snippets, and later runner rollout all read the same contract.
 *
 * Detection uses the OIDC issuer first, then the hostname. `config.environment`
 * cannot distinguish dev from prod because the dev stage reports
 * `environment: "production"` (it's a production build of the dev stage). The
 * issuer keeps local dashboard + dev/prod API proxy runs honest, where the
 * browser hostname is just `localhost`.
 */
import { getDomainContract } from '@boxlite-ai/domain-contract'
import type { DomainContract } from '@boxlite-ai/domain-contract'

export type AppEnvironment = 'local' | 'development' | 'production'

// `local` is intentionally omitted: it falls back to the dashboard's own /api.
const REST_API_URL_BY_ENV: Partial<Record<AppEnvironment, string>> = {
  development: getDomainContract('development').api.canonicalBaseUrl,
  production: getDomainContract('production').api.canonicalBaseUrl,
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

type QuickstartRestApiConfig = {
  apiUrl: string
  oidc?: {
    issuer?: string
  }
  publicEndpoints?: Partial<Pick<DomainContract, 'api'>>
}

export function getQuickstartRestApiUrl(config: QuickstartRestApiConfig): string {
  return config.publicEndpoints?.api?.canonicalBaseUrl ?? getRestApiUrl(config.apiUrl, undefined, config.oidc?.issuer)
}
