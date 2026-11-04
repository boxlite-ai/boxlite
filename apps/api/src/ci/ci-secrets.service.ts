/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { TypedConfigService } from '../config/typed-config.service'

@Injectable()
export class CiSecretsService {
  constructor(private readonly config: TypedConfigService) {}
  private key(): Buffer {
    const value = this.config.get('ci.secretEncryptionKey') || ''
    const key = Buffer.from(value, 'base64')
    if (key.length !== 32 || key.toString('base64') !== value)
      throw new ServiceUnavailableException('CI_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
    return key
  }
  seal(value: string, binding: string): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key(), nonce)
    cipher.setAAD(Buffer.from(binding))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
  }
  open(value: string, binding: string): string {
    try {
      const bytes = Buffer.from(value, 'base64')
      const decipher = createDecipheriv('aes-256-gcm', this.key(), bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from(binding))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    } catch {
      throw new ServiceUnavailableException('CI authorization state unavailable; reconnect')
    }
  }
}
