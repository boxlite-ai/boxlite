/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ServiceUnavailableException } from '@nestjs/common'
import { ProxyCredential } from './proxy-registration.input'

export type CredentialIdentity = { organizationId: string; id: string; revision: number; url: string }
export type CredentialEnvelope = { version: 1; keyId: string; nonce: string; tag: string; ciphertext: string }

const unavailable = () => new ServiceUnavailableException('Proxy credential unavailable')
const keyIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/

function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string') throw unavailable()
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length))
    throw unavailable()
  return bytes
}

function associatedData(keyId: string, { organizationId, id, revision, url }: CredentialIdentity): Buffer {
  return Buffer.from(JSON.stringify([1, keyId, organizationId.toLowerCase(), id.toLowerCase(), revision, url]))
}

export class ProxyCredentialCipher {
  private readonly keys = new Map<string, Buffer>()

  constructor(rawKeys: string | undefined) {
    if (!rawKeys) return
    try {
      const entries: unknown = JSON.parse(rawKeys)
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw unavailable()
      for (const [id, encoded] of Object.entries(entries)) {
        const key = base64(encoded, 32)
        if (!keyIdPattern.test(id) || [...this.keys.values()].some((existing) => key.equals(existing)))
          throw unavailable()
        this.keys.set(id, key)
      }
    } catch {
      throw new Error('Invalid outbound proxy key ring configuration')
    }
  }

  requireKey(id: string): void {
    this.key(id)
  }

  private key(id: string): Buffer {
    const key = this.keys.get(id)
    if (!key) throw unavailable()
    return key
  }

  seal(keyId: string, identity: CredentialIdentity, credential: ProxyCredential): CredentialEnvelope {
    try {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', this.key(keyId), nonce, { authTagLength: 16 })
      cipher.setAAD(associatedData(keyId, identity))
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()])
      return {
        version: 1,
        keyId,
        nonce: nonce.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }
    } catch {
      throw unavailable()
    }
  }

  open(envelope: CredentialEnvelope, identity: CredentialIdentity): ProxyCredential {
    try {
      if (envelope.version !== 1) throw unavailable()
      const decipher = createDecipheriv('aes-256-gcm', this.key(envelope.keyId), base64(envelope.nonce, 12), {
        authTagLength: 16,
      })
      decipher.setAAD(associatedData(envelope.keyId, identity))
      decipher.setAuthTag(base64(envelope.tag, 16))
      const plaintext = Buffer.concat([decipher.update(base64(envelope.ciphertext)), decipher.final()])
      const credential: ProxyCredential = JSON.parse(plaintext.toString('utf8'))
      if (typeof credential.username !== 'string' || typeof credential.password !== 'string') throw unavailable()
      return credential
    } catch {
      throw unavailable()
    }
  }
}
