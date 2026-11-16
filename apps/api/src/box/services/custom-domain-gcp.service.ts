/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Injectable } from '@nestjs/common'
import { GoogleAuth } from 'google-auth-library'
import { TypedConfigService } from '../../config/typed-config.service'
import { CustomDomainRow, DomainProviderState } from './custom-domain-policy'
import { CustomDomainDnsService, DomainSetupError } from './custom-domain-dns.service'

type CloudResource = {
  name: string
  projectId?: string
  projectNumber?: string
  labels?: Record<string, string>
  domain?: string
  hostname?: string
  certificates?: string[]
  managed?: { domains: string[]; dnsAuthorizations: string[]; state: string }
  dnsResourceRecord?: { name: string; type: string; data: string }
  state?: string
  expireTime?: string
  createTime?: string
  done?: boolean
  error?: { code: number }
}

@Injectable()
export class CustomDomainGcpService {
  private readonly auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  private readonly projectNumbers = new Map<string, string>()
  constructor(
    private readonly config: TypedConfigService,
    private readonly dns: CustomDomainDnsService,
  ) {}

  /** One bounded reconciliation step. IDs are stable even if a create response is lost. */
  async reconcile(row: CustomDomainRow, mode: 'prepare' | 'advance' | 'observe' = 'advance', signal?: AbortSignal) {
    const { project, certificateMap } = this.config.getOrThrow('customDomains')
    const request = (method: 'GET' | 'POST' | 'DELETE', path: string, data?: object) =>
      this.request(method, path, data, 'certificatemanager', signal)
    const projectNumber = await this.projectNumber(project, signal)
    const parent = `projects/${project}/locations/global`
    const id = `byo-${row.id}-g${row.generation}`
    const state: DomainProviderState = {
      ...row.provider_state,
      authorization: `${parent}/dnsAuthorizations/${id}`,
      certificate: `${parent}/certificates/${id}`,
      entry: `${parent}/certificateMaps/${certificateMap}/certificateMapEntries/${id}`,
    }
    const labels = { 'boxlite-config': row.id, 'boxlite-generation': String(row.generation) }
    const pending = () => ({ state, phase: row.phase, expires: null as string | null, cleaned: false })
    const projectAlias = (value: string) => value === project || value === projectNumber
    if (state.operation) {
      const operationName = /^projects\/([a-z0-9-]+)\/locations\/global\/operations\/([a-zA-Z0-9_-]+)$/.exec(
        state.operation,
      )
      if (!operationName || !projectAlias(operationName[1])) throw new DomainSetupError('provider_resource_conflict')
      // Always address the configured project, including when Google returns its number.
      const operation = await request('GET', `${parent}/operations/${operationName[2]}`)
      if (operation && !operation.done) return pending()
      delete state.operation
      // Re-read deterministic resource IDs after failed/lost operations; never assume a 409 is success.
    }
    const owned = async (path: string, matches: (value: CloudResource) => boolean) => {
      const resource = await request('GET', path)
      const name = resource?.name?.match(/^projects\/([^/]+)(\/locations\/global\/.+)$/)
      if (
        resource &&
        (!name ||
          !projectAlias(name[1]) ||
          name[2] !== path.slice(`projects/${project}`.length) ||
          resource.labels?.['boxlite-config'] !== row.id ||
          resource.labels?.['boxlite-generation'] !== String(row.generation) ||
          !matches(resource))
      ) {
        throw new DomainSetupError('provider_resource_conflict')
      }
      return resource
    }
    // Google can echo the project ID in a resource's own name but use its number
    // in references. Resource Manager establishes that exact alias relationship.
    const matchesReference = (reference: string, expected: string) =>
      reference === expected || reference === expected.replace(`projects/${project}/`, `projects/${projectNumber}/`)
    const matchesCertificate = (value: CloudResource) =>
      value.managed?.domains?.length === 1 &&
      value.managed.domains[0] === row.hostname &&
      value.managed.dnsAuthorizations?.length === 1 &&
      matchesReference(value.managed.dnsAuthorizations[0], state.authorization)
    const matchesEntry = (value: CloudResource) =>
      value.hostname === row.hostname &&
      value.certificates?.length === 1 &&
      matchesReference(value.certificates[0], state.certificate)

    if (mode === 'observe') {
      const certificate = await owned(state.certificate, matchesCertificate)
      if (!certificate) throw new DomainSetupError('provider_resource_missing')
      state.certificateState = certificate.managed.state
      return { ...pending(), expires: certificate.expireTime ?? null }
    }
    if (row.deleted_at) {
      for (const [path, matches] of [
        [state.entry, matchesEntry],
        [state.certificate, matchesCertificate],
        [state.authorization, (value: CloudResource) => value.domain === row.hostname],
      ] as const) {
        if (await owned(path, matches)) {
          state.operation = (await request('DELETE', path))?.name
          return pending()
        }
      }
      // Keep the tombstone: a timed-out create can finish after a GET returned 404.
      return { ...pending(), cleaned: true }
    }
    const create = async (path: string, parameter: string, data: object) => {
      const collection = path.slice(0, path.lastIndexOf('/'))
      const operation = await request('POST', `${collection}?${parameter}=${id}`, { ...data, labels })
      const match = /^projects\/([a-z0-9-]+)\/locations\/global\/operations\/([a-zA-Z0-9_-]+)$/.exec(
        operation?.name ?? '',
      )
      if (!match || !projectAlias(match[1])) throw new DomainSetupError('provider_invalid_response')
      state.operation = operation.name
    }
    const authorization = await owned(state.authorization, (value) => value.domain === row.hostname)
    if (!authorization) {
      state.progress = 'preparing_dns'
      await create(state.authorization, 'dnsAuthorizationId', { domain: row.hostname, type: 'PER_PROJECT_RECORD' })
      return pending()
    }
    const record = authorization.dnsResourceRecord
    if (record?.type !== 'CNAME' || !record.name || !record.data)
      throw new DomainSetupError('provider_invalid_response')
    state.progress = 'awaiting_dns'
    state.authorizationRecord = { name: record.name, type: 'CNAME', value: record.data }
    const previousRecord = row.provider_state.authorizationRecord
    if (
      previousRecord?.name !== record.name ||
      previousRecord?.type !== record.type ||
      previousRecord?.value !== record.data
    )
      return { ...pending(), phase: 'pending_certificate_dns' as const }
    if (mode === 'prepare') return { ...pending(), phase: 'pending_certificate_dns' as const }
    const certificate = await owned(state.certificate, matchesCertificate)
    if (!certificate) {
      await this.dns.verify(row.hostname, row.challenge, signal)
      await this.dns.verifyCertificate(state.authorizationRecord, signal)
      await create(state.certificate, 'certificateId', {
        managed: { domains: [row.hostname], dnsAuthorizations: [state.authorization] },
      })
      state.certificateSubmitted = true
      state.progress = 'certificate_pending'
      return { ...pending(), phase: 'provisioning' as const }
    }
    state.certificateSubmitted = true
    state.certificateState = certificate.managed.state
    state.progress = 'certificate_pending'
    if (certificate.managed.state === 'FAILED') {
      const created = Date.parse(certificate.createTime)
      if (!Number.isFinite(created)) throw new DomainSetupError('provider_invalid_response')
      // Preserve a still-valid certificate and limit reissuance to once per hour,
      // even when a user repeatedly schedules checks or a replacement fails quickly.
      if (Date.now() - created < 3_600_000 || Date.parse(certificate.expireTime) > Date.now())
        throw new DomainSetupError('certificate_provisioning_failed')
      await this.dns.verify(row.hostname, row.challenge, signal)
      await this.dns.verifyCertificate(state.authorizationRecord, signal)
      const entry = await owned(state.entry, matchesEntry)
      state.operation = (await request('DELETE', entry ? state.entry : state.certificate))?.name
      return { ...pending(), phase: 'provisioning' as const }
    }
    if (certificate.managed.state === 'PROVISIONING') return { ...pending(), phase: 'provisioning' as const }
    if (certificate.managed.state !== 'ACTIVE') throw new DomainSetupError('provider_invalid_response')
    state.progress = 'mapping_pending'
    const entry = await owned(state.entry, matchesEntry)
    if (!entry) {
      await create(state.entry, 'certificateMapEntryId', { hostname: row.hostname, certificates: [state.certificate] })
      return { ...pending(), phase: 'provisioning' as const }
    }
    if (entry.state !== 'ACTIVE') return { ...pending(), phase: 'provisioning' as const }
    if (!certificate.expireTime || !Number.isFinite(Date.parse(certificate.expireTime)))
      throw new DomainSetupError('provider_invalid_response')
    state.progress = 'tls_pending'
    return { ...pending(), phase: 'ready' as const, expires: certificate.expireTime }
  }

  private async projectNumber(project: string, signal?: AbortSignal): Promise<string> {
    const cached = this.projectNumbers.get(project)
    if (cached) return cached
    const value = await this.request('GET', `projects/${project}`, undefined, 'cloudresourcemanager', signal)
    if (
      value?.projectId !== project ||
      typeof value.projectNumber !== 'string' ||
      !/^[1-9][0-9]*$/.test(value.projectNumber)
    )
      throw new DomainSetupError('provider_invalid_response')
    this.projectNumbers.set(project, value.projectNumber)
    return value.projectNumber
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    data?: object,
    service: 'certificatemanager' | 'cloudresourcemanager' = 'certificatemanager',
    signal?: AbortSignal,
  ): Promise<CloudResource | null> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let rejectCancelled: ((error: Error) => void) | undefined
    const cancel = () => {
      abort.abort()
      rejectCancelled?.(new Error('Certificate request cancelled'))
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      return await Promise.race([
        this.auth.getClient().then(async (client) => {
          abort.signal.throwIfAborted()
          return (
            await client.request<CloudResource>({
              url: `https://${service}.googleapis.com/v1/${path}`,
              method,
              data,
              timeout: 10_000,
              retry: false,
              signal: abort.signal,
            })
          ).data
        }),
        new Promise<never>((_, reject) => {
          rejectCancelled = reject
          if (signal?.aborted) {
            cancel()
            return
          }
          timer = setTimeout(() => {
            abort.abort()
            reject(new Error('Certificate request timed out'))
          }, 10_000)
        }),
      ])
    } catch (error) {
      const status = (error as { response?: { status: number } }).response?.status
      if (status === 404 && method !== 'POST') return null
      throw new DomainSetupError(
        status === 429
          ? 'provider_capacity_exhausted'
          : status === 403
            ? 'provider_permission_denied'
            : status === 400
              ? 'provider_request_rejected'
              : 'provider_unavailable',
        false,
        method === 'POST' && path.includes('/certificates?') && [400, 403, 429].includes(status),
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
}
