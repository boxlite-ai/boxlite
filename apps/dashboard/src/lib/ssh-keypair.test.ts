/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import { generateEphemeralSshKeyPair } from './ssh-keypair'

describe('generateEphemeralSshKeyPair', () => {
  it('returns a canonical ed25519 public key line', async () => {
    const { publicKeyLine } = await generateEphemeralSshKeyPair('unit-test')
    expect(publicKeyLine).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* unit-test$/)
  })

  it('returns a well-formed OpenSSH private key PEM', async () => {
    const { privateKeyPem } = await generateEphemeralSshKeyPair()
    expect(privateKeyPem).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/)
    expect(privateKeyPem.trim()).toMatch(/-----END OPENSSH PRIVATE KEY-----$/)
  })

  it('embeds the same public key material in both outputs', async () => {
    const { publicKeyLine, privateKeyPem } = await generateEphemeralSshKeyPair('match-check')

    const body = privateKeyPem
      .split('\n')
      .filter((line) => line && !line.startsWith('-----'))
      .join('')
    const document = Buffer.from(body, 'base64')

    // magic(15) + cipher("none",4+4) + kdf("none",4+4) + kdfoptions(4+0) +
    // numkeys(4) = 39 bytes before the length-prefixed public key blob.
    const publicKeyBlobLength = document.readUInt32BE(39)
    const publicKeyBlob = document.subarray(43, 43 + publicKeyBlobLength)
    const embeddedPublicKeyB64 = publicKeyBlob.toString('base64')

    const [, submittedB64] = publicKeyLine.split(' ')
    expect(embeddedPublicKeyB64).toBe(submittedB64)
  })

  it('generates a fresh keypair on every call', async () => {
    const first = await generateEphemeralSshKeyPair()
    const second = await generateEphemeralSshKeyPair()
    expect(first.publicKeyLine).not.toBe(second.publicKeyLine)
  })
})
