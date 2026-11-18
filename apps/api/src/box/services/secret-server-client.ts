/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { GoogleAuth } from 'google-auth-library'
import { TypedConfigService } from '../../config/typed-config.service'
import { BoxSecret } from '../dto/box.dto'
import { BadRequestError } from '../../exceptions/bad-request.exception'

const TRANSFER_TIMEOUT_MS = 6000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@Injectable()
export class SecretServerClient {
  private readonly logger = new Logger(SecretServerClient.name)
  private readonly auth = new GoogleAuth()

  constructor(private readonly config: TypedConfigService) {}

  async storeBoxSecrets(
    boxId: string,
    orgId: string,
    createdBy: string | undefined,
    secrets: BoxSecret[],
  ): Promise<BoxSecret[]> {
    if (!this.config.get('secretServer.enabled') || secrets.length === 0) return secrets

    // Match the write contract's ASCII name normalization before any remote side effect.
    const names = new Set<string>()
    for (const { name } of secrets) {
      const normalized = name.replace(/[a-z]/g, (letter) => letter.toUpperCase()).replace(/[^A-Z0-9_]/gu, '_')
      if (names.has(normalized)) throw new BadRequestError('Secret names must be unique after normalization')
      names.add(normalized)
    }

    const started = Date.now()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Secret transfer deadline exceeded'))
      }, TRANSFER_TIMEOUT_MS)
    })
    let result = 'failure'
    try {
      const references = await Promise.race([
        this.transfer(boxId, orgId, createdBy, secrets, controller.signal),
        deadline,
      ])
      result = 'success'
      return references
    } catch {
      // Auth/HTTP errors can retain request bodies or echo secret material.
      throw new ServiceUnavailableException({ code: 'secret_store_unavailable', message: 'Secret store unavailable' })
    } finally {
      clearTimeout(timer)
      this.logger.log({ boxId, count: secrets.length, result, latencyMs: Date.now() - started })
    }
  }

  private async transfer(
    boxId: string,
    orgId: string,
    createdBy: string | undefined,
    secrets: BoxSecret[],
    signal: AbortSignal,
  ): Promise<BoxSecret[]> {
    if (!createdBy) throw new Error('Creator identity required')
    const url = this.config.get('secretServer.url')
    const devToken = this.config.get('secretServer.devToken')
    const authorization = devToken
      ? `Bearer ${devToken}`
      : (await (await this.auth.getIdTokenClient(url)).getRequestHeaders()).get('authorization')
    // Identity acquisition cannot be cancelled by the library. Never start a late POST.
    signal.throwIfAborted()
    if (!authorization) throw new Error('Caller identity unavailable')
    const payload = secrets.map(({ name, value, hosts, headers, placeholder }) => ({
      name,
      value,
      hosts,
      headers,
      placeholder: placeholder ?? `<BOXLITE_SECRET:${name}>`,
    }))
    const response = await fetch(`${url}/internal/v1/boxes/${encodeURIComponent(boxId)}/secrets`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, created_by: createdBy, secrets: payload }),
      redirect: 'error',
      signal,
    })
    if (response.status !== 200 && response.status !== 201) {
      await response.body?.cancel()
      throw new Error('Secret transfer rejected')
    }
    const body: unknown = await response.json()
    if (
      !body ||
      typeof body !== 'object' ||
      !('secrets' in body) ||
      !Array.isArray(body.secrets) ||
      body.secrets.length !== secrets.length
    ) {
      throw new Error('Invalid secret mapping')
    }
    const expectedNames = new Set(secrets.map(({ name }) => name))
    const idsByName = new Map<string, string>()
    const ids = new Set<string>()
    for (const entry of body.secrets) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !expectedNames.has(entry.name) ||
        idsByName.has(entry.name) ||
        typeof entry.secret_id !== 'string' ||
        !UUID.test(entry.secret_id) ||
        ids.has(entry.secret_id.toLowerCase())
      ) {
        throw new Error('Invalid secret mapping')
      }
      idsByName.set(entry.name, entry.secret_id)
      ids.add(entry.secret_id.toLowerCase())
    }
    return payload.map(({ name, hosts, headers, placeholder }) => ({
      name,
      hosts,
      headers,
      placeholder,
      secretId: idsByName.get(name),
    }))
  }
}
