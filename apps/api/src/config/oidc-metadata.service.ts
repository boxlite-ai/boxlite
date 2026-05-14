/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpService } from '@nestjs/axios'
import { Injectable, Logger } from '@nestjs/common'
import { OidcMetadata } from 'oidc-client-ts'
import { catchError, firstValueFrom, map } from 'rxjs'
import { TypedConfigService } from './typed-config.service'

export type EndSessionState = 'present' | 'absent' | 'unknown'

/**
 * Parse a value as an http(s) URL with sanity-tight rules. Returns the parsed
 * `URL` or `undefined` if any check fails. Shared by every boundary that
 * receives a URL from a source we don't fully trust (IdP discovery response,
 * operator env, SPA query param).
 *
 * Rejects: non-strings, non-http(s) schemes (blocks javascript:, data:, file:),
 * empty hostnames, and URLs with userinfo (`user:pass@host`) because those
 * leak credentials into logs and the address bar.
 */
export function parseHttpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  if (!u.hostname) return undefined
  if (u.username || u.password) return undefined
  return u
}

export function isValidHttpUrl(value: unknown): value is string {
  return parseHttpUrl(value) !== undefined
}

@Injectable()
export class OidcMetadataService {
  private readonly logger = new Logger(OidcMetadataService.name)
  private cached?: Promise<OidcMetadata>

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: TypedConfigService,
  ) {
    const configured = this.configService.get('oidc.endSessionEndpoint')
    if (configured && !isValidHttpUrl(configured)) {
      this.logger.warn(
        `OIDC_END_SESSION_ENDPOINT is set but not a valid http(s) URL; it will be ignored: ${configured}`,
      )
    }
  }

  getMetadata(): Promise<OidcMetadata> {
    if (!this.cached) {
      const inflight = this.fetchOnce()
      this.cached = inflight
      inflight.catch(() => {
        if (this.cached === inflight) {
          this.cached = undefined
        }
      })
    }
    return this.cached
  }

  async getEndSessionState(): Promise<EndSessionState> {
    let metadata: OidcMetadata
    try {
      metadata = await this.getMetadata()
    } catch (err) {
      this.logger.warn(
        `OIDC discovery probe failed; treating as 'unknown' (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
      )
      return 'unknown'
    }
    if (typeof metadata !== 'object' || metadata === null) {
      // Server returned non-JSON or empty body; the type cast at fetch time lied.
      return 'unknown'
    }
    const endpoint = metadata.end_session_endpoint
    if (endpoint === undefined) {
      // Canonically missing — the IdP intentionally doesn't advertise it.
      return 'absent'
    }
    // Field is present in the doc; only call it "valid" if it's a real URL.
    return isValidHttpUrl(endpoint) ? 'present' : 'unknown'
  }

  private async fetchOnce(): Promise<OidcMetadata> {
    // Strip trailing slash so the composed URL doesn't get a `//` segment some
    // IdPs reject (Keycloak in strict mode, certain Auth0 tenants).
    const issuer = this.configService.getOrThrow('oidc.issuer').replace(/\/+$/, '')
    const discoveryUrl = `${issuer}/.well-known/openid-configuration`
    return firstValueFrom(
      this.httpService.get(discoveryUrl).pipe(
        map((response) => response.data as OidcMetadata),
        catchError((error) => {
          throw new Error(`Failed to fetch OpenID configuration from ${discoveryUrl}: ${error.message}`)
        }),
      ),
    )
  }
}
