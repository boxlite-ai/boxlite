import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { RUNNER_PORT, type RunnerSlot } from './runners.ts'

export type RunnerProtectedProxy = {
  runnerId: string
  url: string
  caPem: string
  caFile: string
  certFile: string
  keyFile: string
  dohUrl: string
  dohAddress: string
}

export function enrollProtectedRunnerSlots(fleet: RunnerSlot[], raw: string | null): RunnerSlot[] {
  if (raw === null) return fleet
  const enrollments = JSON.parse(raw) as Record<string, RunnerProtectedProxy>
  if (!enrollments || typeof enrollments !== 'object' || Array.isArray(enrollments)) {
    throw new Error('Protected Runner enrollment must be keyed by slot resource name')
  }
  const identities = new Set<string>()
  for (const [name, enrollment] of Object.entries(enrollments)) {
    if (!fleet.slice(1).some((slot) => slot.resourceName === name)) {
      throw new Error('Protected Runner enrollment must reference a non-default stage slot')
    }
    const url = new URL(enrollment.url)
    if (
      url.protocol !== 'https:' ||
      url.port !== String(RUNNER_PORT) ||
      isIP(url.hostname) ||
      !/^[a-z0-9.-]+$/.test(url.hostname) ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(enrollment.runnerId) ||
      identities.has(enrollment.runnerId) ||
      !new X509Certificate(enrollment.caPem).ca ||
      ![enrollment.caFile, enrollment.certFile, enrollment.keyFile].every((file) =>
        /^\/[a-zA-Z0-9/_.-]+$/.test(file),
      ) ||
      !/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?\/[a-zA-Z0-9/_.-]+$/.test(enrollment.dohUrl) ||
      !/^[0-9.]+:[0-9]+$/.test(enrollment.dohAddress)
    ) {
      throw new Error('Invalid protected Runner enrollment')
    }
    identities.add(enrollment.runnerId)
  }
  return fleet.map((slot) =>
    Object.hasOwn(enrollments, slot.resourceName) ? { ...slot, protectedProxy: enrollments[slot.resourceName] } : slot,
  )
}

export function protectedRunnerServiceEnvironment(
  enrollment: RunnerProtectedProxy | undefined,
): Record<string, string> {
  if (!enrollment) return {}
  return {
    API_VERSION: '0',
    ENABLE_TLS: 'true',
    TLS_CERT_FILE: enrollment.certFile,
    TLS_KEY_FILE: enrollment.keyFile,
    BOXLITE_PROTECTED_PROXY_RUNNER_ID: enrollment.runnerId,
    BOXLITE_PROTECTED_PROXY_DNS_NAME: new URL(enrollment.url).hostname,
    BOXLITE_PROTECTED_PROXY_CA_FILE: enrollment.caFile,
    BOXLITE_PROTECTED_PROXY_DOH_URL: enrollment.dohUrl,
    BOXLITE_PROTECTED_PROXY_DOH_ADDRESS: enrollment.dohAddress,
  }
}

export function protectedRunnerCloudEnvironment(fleet: readonly RunnerSlot[]): Record<string, string> {
  const pins = fleet.flatMap(({ protectedProxy }) =>
    protectedProxy ? [{ runnerId: protectedProxy.runnerId, url: protectedProxy.url, caPem: protectedProxy.caPem }] : [],
  )
  return pins.length ? { BOXLITE_PROTECTED_PROXY_ENROLLMENTS: JSON.stringify(pins) } : {}
}
