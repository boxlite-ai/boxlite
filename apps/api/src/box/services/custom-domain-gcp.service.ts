/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Injectable } from '@nestjs/common'
import { GoogleAuth } from 'google-auth-library'
import { TypedConfigService } from '../../config/typed-config.service'
import { CustomDomainRow, DomainProviderState } from './custom-domain-policy'
import { DomainSetupError } from './custom-domain-dns.service'

type CloudResource = {
  name: string
  labels?: Record<string, string>
  domain?: string
  hostname?: string
  certificates?: string[]
  managed?: { domains: string[]; dnsAuthorizations: string[]; state: string }
  dnsResourceRecord?: { name: string; type: string; data: string }
  state?: string
  expireTime?: string
  done?: boolean
  error?: { code: number }
}

@Injectable()
export class CustomDomainGcpService {
  private readonly auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  constructor(private readonly config: TypedConfigService) {}

  /** One bounded reconciliation step. IDs are stable even if a create response is lost. */
  async reconcile(row: CustomDomainRow) {
    const { project, certificateMap } = this.config.getOrThrow('customDomains')
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
    if (state.operation) {
      if (
        !state.operation.startsWith(`${parent}/operations/`) ||
        !/^projects\/[a-z0-9-]+\/locations\/global\/operations\/[a-zA-Z0-9_-]+$/.test(state.operation)
      )
        throw new DomainSetupError('provider_resource_conflict')
      const operation = await this.request('GET', state.operation)
      if (operation && !operation.done) return pending()
      delete state.operation
      // Re-read deterministic resource IDs after failed/lost operations; never assume a 409 is success.
    }
    const owned = async (path: string, matches: (value: CloudResource) => boolean) => {
      const resource = await this.request('GET', path)
      if (
        resource &&
        (resource.labels?.['boxlite-config'] !== row.id ||
          resource.labels?.['boxlite-generation'] !== String(row.generation) ||
          !matches(resource))
      ) {
        throw new DomainSetupError('provider_resource_conflict')
      }
      return resource
    }
    const matchesCertificate = (value: CloudResource) =>
      value.managed?.domains?.length === 1 &&
      value.managed.domains[0] === row.hostname &&
      value.managed.dnsAuthorizations?.length === 1 &&
      value.managed.dnsAuthorizations[0] === state.authorization
    const matchesEntry = (value: CloudResource) =>
      value.hostname === row.hostname && value.certificates?.length === 1 && value.certificates[0] === state.certificate

    if (row.deleted_at) {
      for (const [path, matches] of [
        [state.entry, matchesEntry],
        [state.certificate, matchesCertificate],
        [state.authorization, (value: CloudResource) => value.domain === row.hostname],
      ] as const) {
        if (await owned(path, matches)) {
          state.operation = (await this.request('DELETE', path))?.name
          return pending()
        }
      }
      // Keep the tombstone: a timed-out create can finish after a GET returned 404.
      return { ...pending(), cleaned: true }
    }
    const create = async (path: string, parameter: string, data: object) => {
      const collection = path.slice(0, path.lastIndexOf('/'))
      state.operation = (await this.request('POST', `${collection}?${parameter}=${id}`, { ...data, labels }))?.name
    }
    const authorization = await owned(state.authorization, (value) => value.domain === row.hostname)
    if (!authorization) {
      await create(state.authorization, 'dnsAuthorizationId', { domain: row.hostname, type: 'PER_PROJECT_RECORD' })
      return pending()
    }
    const record = authorization.dnsResourceRecord
    if (record?.type !== 'CNAME' || !record.name || !record.data)
      throw new DomainSetupError('provider_invalid_response')
    state.authorizationRecord = { name: record.name, type: 'CNAME', value: record.data }
    if (!row.provider_state.authorizationRecord) return { ...pending(), phase: 'pending_certificate_dns' as const }
    const certificate = await owned(state.certificate, matchesCertificate)
    if (!certificate) {
      await create(state.certificate, 'certificateId', {
        managed: { domains: [row.hostname], dnsAuthorizations: [state.authorization] },
      })
      return { ...pending(), phase: 'pending_certificate_dns' as const }
    }
    if (certificate.managed.state === 'FAILED') throw new DomainSetupError('certificate_provisioning_failed')
    if (certificate.managed.state !== 'ACTIVE') return { ...pending(), phase: 'pending_certificate_dns' as const }
    const entry = await owned(state.entry, matchesEntry)
    if (!entry) {
      await create(state.entry, 'certificateMapEntryId', { hostname: row.hostname, certificates: [state.certificate] })
      return { ...pending(), phase: 'provisioning' as const }
    }
    if (entry.state !== 'ACTIVE') return { ...pending(), phase: 'provisioning' as const }
    if (!certificate.expireTime || !Number.isFinite(Date.parse(certificate.expireTime)))
      throw new DomainSetupError('provider_invalid_response')
    return { ...pending(), phase: 'ready' as const, expires: certificate.expireTime }
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, data?: object): Promise<CloudResource | null> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    try {
      return await Promise.race([
        this.auth.getClient().then(
          async (client) =>
            (
              await client.request<CloudResource>({
                url: `https://certificatemanager.googleapis.com/v1/${path}`,
                method,
                data,
                timeout: 10_000,
                retry: false,
                signal: abort.signal,
              })
            ).data,
        ),
        new Promise<never>((_, reject) => {
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
            : 'provider_unavailable',
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
