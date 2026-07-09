/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export type BoxLiteEnvironment = 'development' | 'production'
export type DomainContractEnvironment = BoxLiteEnvironment | 'custom'

export type ApiDomainContract = {
  canonicalBaseUrl: string
  legacyBaseUrls: readonly string[]
}

export type DashboardDomainContract = {
  canonicalUrl: string
  legacyUrls: readonly string[]
}

export type DomainContract = {
  environment: DomainContractEnvironment
  stackDomain: string
  dashboard: DashboardDomainContract
  api: ApiDomainContract
}

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '')

export function withApiPrefix(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/api`
}

export const BOXLITE_DOMAIN_CONTRACT = {
  development: {
    environment: 'custom',
    stackDomain: 'dev.boxlite.ai',
    dashboard: {
      canonicalUrl: 'https://dev.boxlite.ai/dashboard',
      legacyUrls: ['https://dev.boxlite.ai'],
    },
    api: {
      canonicalBaseUrl: 'https://api.dev.boxlite.ai',
      legacyBaseUrls: ['https://api.dev.boxlite.ai/api', 'https://dev.boxlite.ai/api'],
    },
  },
  production: {
    environment: 'production',
    stackDomain: 'boxlite.ai',
    dashboard: {
      canonicalUrl: 'https://boxlite.ai/dashboard',
      legacyUrls: ['https://app.boxlite.ai/dashboard'],
    },
    api: {
      canonicalBaseUrl: 'https://api.boxlite.ai',
      legacyBaseUrls: ['https://api.app.boxlite.ai/api', 'https://api.boxlite.ai/api'],
    },
  },
} as const satisfies Record<BoxLiteEnvironment, DomainContract>

export function getDomainContract(environment: BoxLiteEnvironment): DomainContract {
  return BOXLITE_DOMAIN_CONTRACT[environment]
}

export function resolveEnvironmentFromStackDomain(stackDomain: string): BoxLiteEnvironment | undefined {
  const normalized = stackDomain.trim().toLowerCase()
  if (normalized === 'dev.boxlite.ai') return 'development'
  if (normalized === 'boxlite.ai' || normalized === 'app.boxlite.ai') return 'production'
  return undefined
}

export function getDomainContractForStackDomain(stackDomain: string): DomainContract {
  const environment = resolveEnvironmentFromStackDomain(stackDomain)
  if (environment) return getDomainContract(environment)

  const normalized = stackDomain.trim().toLowerCase()
  return {
    environment: 'development',
    stackDomain: normalized,
    dashboard: {
      canonicalUrl: `https://${normalized}/dashboard`,
      legacyUrls: [`https://${normalized}`],
    },
    api: {
      canonicalBaseUrl: `https://api.${normalized}`,
      legacyBaseUrls: [`https://api.${normalized}/api`, `https://${normalized}/api`],
    },
  }
}

export function getPrimaryLegacyApiBaseUrl(contract: DomainContract): string {
  return contract.api.legacyBaseUrls[0] ?? withApiPrefix(contract.api.canonicalBaseUrl)
}

export function getHostFromUrl(url: string): string {
  return new URL(url).host.toLowerCase()
}

export function getUnprefixedApiHosts(contract: DomainContract): readonly string[] {
  return [
    ...new Set([
      getHostFromUrl(contract.api.canonicalBaseUrl),
      ...contract.api.legacyBaseUrls.map(getHostFromUrl).filter((host) => host.startsWith('api.')),
    ]),
  ]
}
