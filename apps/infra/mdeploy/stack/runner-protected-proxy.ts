import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { RUNNER_PORT, type RunnerSlot } from './runners.ts'

export const PROTECTED_V2_PORT = 3004
export const PROTECTED_V2_LISTENER_ENV = {
  address: 'BOXLITE_PROTECTED_PROXY_LISTEN_ADDRESS',
  certFile: 'BOXLITE_PROTECTED_PROXY_CERT_FILE',
  keyFile: 'BOXLITE_PROTECTED_PROXY_KEY_FILE',
  clientCaFile: 'BOXLITE_PROTECTED_PROXY_CLIENT_CA_FILE',
  clientDnsName: 'BOXLITE_PROTECTED_PROXY_CLIENT_DNS_NAME',
} as const

export type RunnerProtectedProxy = {
  runnerId: string
  url: string
  caPem: string
  caFile: string
  certFile: string
  keyFile: string
  dohUrl: string
  dohAddress: string
} & ({ apiVersion?: 0 } | { apiVersion: 2; clientCaFile: string; clientDnsName: string })

export function enrollProtectedRunnerSlots(fleet: RunnerSlot[], raw: string | null): RunnerSlot[] {
  if (raw === null) return fleet
  const enrollments = JSON.parse(raw) as Record<string, RunnerProtectedProxy>
  if (!enrollments || typeof enrollments !== 'object' || Array.isArray(enrollments)) {
    throw new Error('Protected Runner enrollment must be keyed by slot resource name')
  }
  const identities = new Set<string>()
  const endpoints = new Set<string>()
  for (const [name, enrollment] of Object.entries(enrollments)) {
    const v2 = enrollment.apiVersion === 2
    if (!(v2 ? fleet : fleet.slice(1)).some((slot) => slot.resourceName === name)) {
      throw new Error('Protected Runner enrollment must reference a stage slot eligible for its API version')
    }
    const url = new URL(enrollment.url)
    const files = [enrollment.caFile, enrollment.certFile, enrollment.keyFile]
    if (v2) files.push(enrollment.clientCaFile)
    if (
      (enrollment.apiVersion !== undefined && enrollment.apiVersion !== 0 && !v2) ||
      url.protocol !== 'https:' ||
      url.port !== String(v2 ? PROTECTED_V2_PORT : RUNNER_PORT) ||
      isIP(url.hostname) ||
      !/^[a-z0-9.-]+$/.test(url.hostname) ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      endpoints.has(url.href) ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(enrollment.runnerId) ||
      identities.has(enrollment.runnerId) ||
      !new X509Certificate(enrollment.caPem).ca ||
      !files.every((file) => typeof file === 'string' && /^\/[a-zA-Z0-9/_.-]+$/.test(file)) ||
      (v2 && (typeof enrollment.clientDnsName !== 'string' || !/^[a-z0-9.-]+$/.test(enrollment.clientDnsName))) ||
      !/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?\/[a-zA-Z0-9/_.-]+$/.test(enrollment.dohUrl) ||
      !/^[0-9.]+:[0-9]+$/.test(enrollment.dohAddress)
    ) {
      throw new Error('Invalid protected Runner enrollment')
    }
    identities.add(enrollment.runnerId)
    endpoints.add(url.href)
  }
  return fleet.map((slot) =>
    Object.hasOwn(enrollments, slot.resourceName) ? { ...slot, protectedProxy: enrollments[slot.resourceName] } : slot,
  )
}

export function protectedRunnerServiceEnvironment(
  enrollment: RunnerProtectedProxy | undefined,
): Record<string, string> {
  if (!enrollment) return {}
  const identity = {
    BOXLITE_PROTECTED_PROXY_RUNNER_ID: enrollment.runnerId,
    BOXLITE_PROTECTED_PROXY_DNS_NAME: new URL(enrollment.url).hostname,
    BOXLITE_PROTECTED_PROXY_CA_FILE: enrollment.caFile,
    BOXLITE_PROTECTED_PROXY_DOH_URL: enrollment.dohUrl,
    BOXLITE_PROTECTED_PROXY_DOH_ADDRESS: enrollment.dohAddress,
  }
  if (enrollment.apiVersion === 2) {
    return {
      ...identity,
      API_VERSION: '2',
      [PROTECTED_V2_LISTENER_ENV.address]: `:${PROTECTED_V2_PORT}`,
      [PROTECTED_V2_LISTENER_ENV.certFile]: enrollment.certFile,
      [PROTECTED_V2_LISTENER_ENV.keyFile]: enrollment.keyFile,
      [PROTECTED_V2_LISTENER_ENV.clientCaFile]: enrollment.clientCaFile,
      [PROTECTED_V2_LISTENER_ENV.clientDnsName]: enrollment.clientDnsName,
    }
  }
  return {
    ...identity,
    API_VERSION: '0',
    ENABLE_TLS: 'true',
    TLS_CERT_FILE: enrollment.certFile,
    TLS_KEY_FILE: enrollment.keyFile,
  }
}

export function protectedRunnerCloudEnvironment(fleet: readonly RunnerSlot[]): Record<string, string> {
  const pins = fleet.flatMap(({ protectedProxy }) =>
    protectedProxy && protectedProxy.apiVersion !== 2
      ? [{ runnerId: protectedProxy.runnerId, url: protectedProxy.url, caPem: protectedProxy.caPem }]
      : [],
  )
  return pins.length ? { BOXLITE_PROTECTED_PROXY_ENROLLMENTS: JSON.stringify(pins) } : {}
}
