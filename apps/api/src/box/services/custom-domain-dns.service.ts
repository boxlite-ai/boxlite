/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Injectable } from '@nestjs/common'
import { Resolver } from 'node:dns/promises'
import { connect } from 'node:tls'
import { TypedConfigService } from '../../config/typed-config.service'
import { DomainDnsCheck, DomainDnsRecord } from './custom-domain-policy'

export class DomainSetupError extends Error {
  constructor(
    readonly code: string,
    readonly invalidateDns = false,
    readonly submissionRejected = false,
  ) {
    super(code)
  }
}
const canonical = (name: string) => name.toLowerCase().replace(/\.$/, '')

@Injectable()
export class CustomDomainDnsService {
  constructor(private readonly config: TypedConfigService) {}

  async checkAll(
    hostname: string,
    challenge: string,
    record: DomainDnsRecord,
    signal?: AbortSignal,
  ): Promise<DomainDnsCheck[]> {
    return Promise.all(
      (
        [
          ['ownership', () => this.verifyOwnership(hostname, challenge, signal)],
          ['traffic', () => this.verifyTraffic(hostname, signal)],
          ['certificate', () => this.verifyCertificate(record, signal)],
        ] as const
      ).map(async ([record, check]) => {
        try {
          await check()
          return { record, status: 'passed' as const }
        } catch (error) {
          const code = error instanceof DomainSetupError ? error.code : 'dns_unavailable'
          return {
            record,
            status: code === 'dns_unavailable' ? ('unavailable' as const) : ('failed' as const),
            errorCode: code,
          }
        }
      }),
    )
  }

  async verifyCertificate(record: DomainDnsRecord, signal?: AbortSignal): Promise<void> {
    await this.resolve(
      'certificate_dns_mismatch',
      async (resolver) => {
        const names = await resolver.resolveCname(record.name)
        if (names.length !== 1 || canonical(names[0]) !== canonical(record.value))
          throw new DomainSetupError('certificate_dns_mismatch')
      },
      signal,
    )
  }

  async verify(hostname: string, challenge: string, signal?: AbortSignal): Promise<void> {
    await this.verifyOwnership(hostname, challenge, signal)
    await this.verifyTraffic(hostname, signal)
  }

  private async verifyOwnership(hostname: string, challenge: string, signal?: AbortSignal) {
    await this.resolve(
      'ownership_txt_mismatch',
      async (resolver) => {
        const txt = await resolver.resolveTxt(`_boxlite-verification.${hostname}`)
        if (!txt.some((parts) => parts.join('') === `boxlite-verification=${challenge}`))
          throw new DomainSetupError('ownership_txt_mismatch', true)
      },
      signal,
    )
  }

  private async verifyTraffic(hostname: string, signal?: AbortSignal) {
    await this.resolve(
      'traffic_cname_mismatch',
      async (resolver) => {
        const { trafficHost, edgeIps } = this.config.getOrThrow('customDomains')
        let current = hostname
        const visited = new Set<string>()
        while (current !== trafficHost) {
          signal?.throwIfAborted()
          if (visited.has(current) || visited.size >= 8) throw new DomainSetupError('traffic_cname_mismatch', true)
          visited.add(current)
          const names = await resolver.resolveCname(current)
          if (names.length !== 1) throw new DomainSetupError('traffic_cname_mismatch', true)
          current = canonical(names[0])
        }
        const addresses = (
          await Promise.all(
            [resolver.resolve4(hostname), resolver.resolve6(hostname)].map(async (result) => {
              try {
                return await result
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENODATA') return []
                throw error
              }
            }),
          )
        ).flat()
        if (!addresses.length || addresses.some((ip) => !edgeIps.includes(ip)))
          throw new DomainSetupError('traffic_address_mismatch', true)
      },
      signal,
    )
  }

  private async resolve(missing: string, work: (resolver: Resolver) => Promise<void>, signal?: AbortSignal) {
    const resolver = new Resolver({ timeout: 2000, tries: 1 })
    resolver.setServers(['8.8.8.8', '1.1.1.1'])
    const cancel = () => resolver.cancel()
    const timer = setTimeout(cancel, 8_000)
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      await work(resolver)
      signal?.throwIfAborted()
    } catch (error) {
      if (error instanceof DomainSetupError) throw error
      if (['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException).code))
        throw new DomainSetupError(missing, missing !== 'certificate_dns_mismatch')
      throw new DomainSetupError('dns_unavailable')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      resolver.cancel()
    }
  }

  async verifyTls(hostname: string, signal?: AbortSignal): Promise<string> {
    let expiry = Infinity
    for (const ip of this.config.getOrThrow('customDomains.edgeIps')) {
      signal?.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: ip, port: 443, servername: hostname, rejectUnauthorized: true })
        const cancel = () => socket.destroy(new Error('TLS probe timed out'))
        const timer = setTimeout(cancel, 5000)
        const cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', cancel)
          socket.destroy()
        }
        signal?.addEventListener('abort', cancel, { once: true })
        socket.once('secureConnect', () => {
          const validUntil = Date.parse(socket.getPeerCertificate().valid_to)
          cleanup()
          if (!Number.isFinite(validUntil)) reject(new DomainSetupError('https_not_ready'))
          else {
            expiry = Math.min(expiry, validUntil)
            resolve()
          }
        })
        socket.once('error', () => {
          cleanup()
          reject(new DomainSetupError('https_not_ready'))
        })
      })
    }
    return new Date(expiry).toISOString()
  }
}
