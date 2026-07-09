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

export type ProxyDomainContract = {
  domain: string
  wildcardDomain: string
  protocol: 'http' | 'https'
  templateUrl: string
  toolboxBaseUrl: string
}

export type SshGatewayDomainContract = {
  host: string
  port: number
  url: string
}

export type DomainContract = {
  environment: DomainContractEnvironment
  stackDomain: string
  dashboard: DashboardDomainContract
  api: ApiDomainContract
  proxy: ProxyDomainContract
  sshGateway: SshGatewayDomainContract
}

const trimTrailingSlash = (url: string) => url.replace(/\/+$/, '')
const DEFAULT_SSH_GATEWAY_PORT = 2222

export function withApiPrefix(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}/api`
}

function buildProxyContract(domain: string, protocol: 'http' | 'https' = 'https'): ProxyDomainContract {
  const normalizedDomain = domain.trim().toLowerCase()
  return {
    domain: normalizedDomain,
    wildcardDomain: `*.${normalizedDomain}`,
    protocol,
    templateUrl: `${protocol}://{{PORT}}-{{boxId}}.${normalizedDomain}`,
    toolboxBaseUrl: `${protocol}://${normalizedDomain}`,
  }
}

function buildSshGatewayContract(host: string, port = DEFAULT_SSH_GATEWAY_PORT): SshGatewayDomainContract {
  const normalizedHost = host.trim().toLowerCase()
  return {
    host: normalizedHost,
    port,
    url: `ssh://${normalizedHost}:${port}`,
  }
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
    proxy: buildProxyContract('proxy.dev.boxlite.ai'),
    sshGateway: buildSshGatewayContract('ssh.dev.boxlite.ai'),
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
    proxy: buildProxyContract('proxy.boxlite.ai'),
    sshGateway: buildSshGatewayContract('ssh.boxlite.ai'),
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
    proxy: buildProxyContract(`proxy.${normalized}`),
    sshGateway: buildSshGatewayContract(`ssh.${normalized}`),
  }
}

type PublicEndpointEnv = Record<string, string | undefined>

const normalizeEnvUrl = (url: string) => trimTrailingSlash(url.trim())
const parseCsv = (value: string | undefined) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizeEnvUrl) ?? []
const getEnv = (env: PublicEndpointEnv, ...keys: string[]) => keys.map((key) => env[key]?.trim()).find(Boolean)
const unique = <T>(items: readonly T[]) => [...new Set(items)]
const parsePort = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
const parseProtocol = (value: string | undefined, fallback: 'http' | 'https'): 'http' | 'https' =>
  value === 'http' || value === 'https' ? value : fallback

function parseSshGatewayUrl(value: string | undefined): Partial<SshGatewayDomainContract> {
  if (!value?.trim()) return {}
  const raw = value.trim()

  if (raw.includes('://')) {
    const url = new URL(raw)
    return {
      host: url.hostname.toLowerCase(),
      port: parsePort(url.port, DEFAULT_SSH_GATEWAY_PORT),
      url: raw,
    }
  }

  const [host, port] = raw.split(':')
  return {
    host: host?.trim().toLowerCase(),
    port: parsePort(port, DEFAULT_SSH_GATEWAY_PORT),
    url: raw,
  }
}

function withOverrides<T extends { [key: string]: unknown }>(base: T, overrides: Partial<T>): T {
  return { ...base, ...overrides }
}

export function resolvePublicEndpointContract(env: PublicEndpointEnv): DomainContract {
  const stackDomain = getEnv(env, 'STACK_DOMAIN') ?? 'dev.boxlite.ai'
  const base = getDomainContractForStackDomain(stackDomain)

  const canonicalApiBaseUrl = normalizeEnvUrl(getEnv(env, 'PUBLIC_API_BASE_URL') ?? base.api.canonicalBaseUrl)
  const legacyApiBaseUrls = parseCsv(env['PUBLIC_LEGACY_API_BASE_URLS'])
  const legacyApiFallbacks =
    legacyApiBaseUrls.length > 0
      ? legacyApiBaseUrls
      : unique([
          ...parseCsv(env['PUBLIC_REST_API_BASE_URL']),
          ...parseCsv(env['PUBLIC_REST_LEGACY_API_BASE_URL']),
          ...base.api.legacyBaseUrls.map(normalizeEnvUrl),
        ]).filter((url) => url !== canonicalApiBaseUrl)

  const dashboardCanonicalUrl = normalizeEnvUrl(getEnv(env, 'PUBLIC_DASHBOARD_BASE_URL') ?? base.dashboard.canonicalUrl)

  const proxyProtocol = parseProtocol(getEnv(env, 'PUBLIC_PROXY_PROTOCOL', 'PROXY_PROTOCOL'), base.proxy.protocol)
  const proxyDomain = getEnv(env, 'PUBLIC_PROXY_DOMAIN', 'PROXY_DOMAIN') ?? base.proxy.domain
  const proxy = withOverrides(buildProxyContract(proxyDomain, proxyProtocol), {
    templateUrl: normalizeEnvUrl(
      getEnv(env, 'PUBLIC_PROXY_TEMPLATE_URL', 'PROXY_TEMPLATE_URL') ??
        buildProxyContract(proxyDomain, proxyProtocol).templateUrl,
    ),
    toolboxBaseUrl: normalizeEnvUrl(
      getEnv(env, 'PUBLIC_PROXY_TOOLBOX_BASE_URL', 'PROXY_TOOLBOX_BASE_URL') ??
        buildProxyContract(proxyDomain, proxyProtocol).toolboxBaseUrl,
    ),
  })

  const parsedSshGateway = parseSshGatewayUrl(getEnv(env, 'PUBLIC_SSH_GATEWAY_URL', 'SSH_GATEWAY_URL'))
  const sshGatewayHost = getEnv(env, 'PUBLIC_SSH_GATEWAY_HOST') ?? parsedSshGateway.host ?? base.sshGateway.host
  const sshGatewayPort = parsePort(
    env['PUBLIC_SSH_GATEWAY_PORT'] ?? String(parsedSshGateway.port ?? ''),
    base.sshGateway.port,
  )
  const sshGatewayUrl =
    getEnv(env, 'PUBLIC_SSH_GATEWAY_URL', 'SSH_GATEWAY_URL') ?? `ssh://${sshGatewayHost}:${sshGatewayPort}`

  return {
    ...base,
    stackDomain: stackDomain.trim().toLowerCase(),
    dashboard: {
      canonicalUrl: dashboardCanonicalUrl,
      legacyUrls: base.dashboard.legacyUrls.map(normalizeEnvUrl).filter((url) => url !== dashboardCanonicalUrl),
    },
    api: {
      canonicalBaseUrl: canonicalApiBaseUrl,
      legacyBaseUrls: legacyApiFallbacks,
    },
    proxy,
    sshGateway: {
      host: sshGatewayHost.trim().toLowerCase(),
      port: sshGatewayPort,
      url: sshGatewayUrl,
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
  return [getHostFromUrl(contract.api.canonicalBaseUrl)]
}
