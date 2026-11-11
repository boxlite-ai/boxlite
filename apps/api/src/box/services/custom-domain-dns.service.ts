/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Injectable } from '@nestjs/common'
import { Resolver } from 'node:dns/promises'
import { connect } from 'node:tls'
import { TypedConfigService } from '../../config/typed-config.service'
import { DomainDnsRecord } from './custom-domain-policy'

export class DomainSetupError extends Error {
  constructor(
    readonly code: string,
    readonly invalidateDns = false,
  ) {
    super(code)
  }
}

@Injectable()
export class CustomDomainDnsService {
  constructor(private readonly config: TypedConfigService) {}

  async verifyCertificate(record: DomainDnsRecord): Promise<void> {
    const resolver = new Resolver({ timeout: 2000, tries: 1 })
    resolver.setServers(['8.8.8.8', '1.1.1.1'])
    const canonical = (name: string) => name.toLowerCase().replace(/\.$/, '')
    try {
      const names = await resolver.resolveCname(record.name)
      if (names.length !== 1 || canonical(names[0]) !== canonical(record.value))
        throw new DomainSetupError('certificate_dns_mismatch')
    } catch (error) {
      if (error instanceof DomainSetupError) throw error
      if (['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException).code))
        throw new DomainSetupError('certificate_dns_mismatch')
      throw new DomainSetupError('dns_unavailable')
    } finally {
      resolver.cancel()
    }
  }

  async verify(hostname: string, challenge: string): Promise<void> {
    const resolver = new Resolver({ timeout: 2000, tries: 1 })
    // Use public DNS, not a pod's split-horizon resolver or a customer's DNS server address.
    resolver.setServers(['8.8.8.8', '1.1.1.1'])
    const canonical = (name: string) => name.toLowerCase().replace(/\.$/, '')
    try {
      const txt = await resolver.resolveTxt(`_boxlite-verification.${hostname}`)
      if (!txt.some((parts) => parts.join('') === `boxlite-verification=${challenge}`))
        throw new DomainSetupError('ownership_txt_mismatch', true)
      const { trafficHost, edgeIps } = this.config.getOrThrow('customDomains')
      let current = hostname
      const visited = new Set<string>()
      while (current !== trafficHost) {
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
    } catch (error) {
      if (error instanceof DomainSetupError) throw error
      if (['ENODATA', 'ENOTFOUND'].includes((error as NodeJS.ErrnoException).code))
        throw new DomainSetupError('dns_record_missing', true)
      throw new DomainSetupError('dns_unavailable')
    } finally {
      resolver.cancel()
    }
  }

  async verifyTls(hostname: string): Promise<string> {
    let expiry = Infinity
    for (const ip of this.config.getOrThrow('customDomains.edgeIps')) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: ip, port: 443, servername: hostname, rejectUnauthorized: true })
        const timer = setTimeout(() => socket.destroy(new Error('TLS probe timed out')), 5000)
        socket.once('secureConnect', () => {
          const validUntil = Date.parse(socket.getPeerCertificate().valid_to)
          clearTimeout(timer)
          socket.destroy()
          if (!Number.isFinite(validUntil)) reject(new DomainSetupError('https_not_ready'))
          else {
            expiry = Math.min(expiry, validUntil)
            resolve()
          }
        })
        socket.once('error', () => {
          clearTimeout(timer)
          socket.destroy()
          reject(new DomainSetupError('https_not_ready'))
        })
      })
    }
    return new Date(expiry).toISOString()
  }
}
