/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { generateKeyPairSync, randomBytes } from 'crypto'
import {
  ed25519SpkiToOpenSshBlob,
  encodeEd25519PublicKeyBlob,
  formatOpenSshPublicKey,
  MAX_PUBLIC_KEY_INPUT_LENGTH,
  parseSshPublicKey,
  sshPublicKeyFingerprint,
} from './openssh-public-key'
import { SshWireWriter } from './openssh-wire'
import { SshCertificateError, SshCertificateErrorCode } from './ssh-certificate.errors'

function generateOpenSshEd25519PublicKey(comment = 'user@example'): string {
  const { publicKey } = generateKeyPairSync('ed25519')
  const blob = ed25519SpkiToOpenSshBlob(publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
  return `${formatOpenSshPublicKey(blob)} ${comment}`
}

function expectErrorCode(run: () => unknown, code: SshCertificateErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(SshCertificateError)
    expect((error as SshCertificateError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code} to be thrown`)
}

describe('parseSshPublicKey', () => {
  it('canonicalizes an Ed25519 key by stripping the comment and re-encoding the blob', () => {
    const input = generateOpenSshEd25519PublicKey('someone@laptop')

    const parsed = parseSshPublicKey(input)

    expect(parsed.algorithm).toBe('ssh-ed25519')
    expect(parsed.keyMaterial).toHaveLength(32)
    expect(parsed.openssh).toBe(input.split(' ').slice(0, 2).join(' '))
    expect(parsed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(parsed.blob.equals(encodeEd25519PublicKeyBlob(parsed.keyMaterial))).toBe(true)
  })

  it.each([undefined, null, '', '   ', 42])('rejects missing input %p with SSH_PUBLIC_KEY_REQUIRED', (input) => {
    expectErrorCode(() => parseSshPublicKey(input), SshCertificateErrorCode.SSH_PUBLIC_KEY_REQUIRED)
  })

  it('rejects oversized input before decoding it', () => {
    const oversized = `ssh-ed25519 ${'A'.repeat(MAX_PUBLIC_KEY_INPUT_LENGTH)}`

    expectErrorCode(() => parseSshPublicKey(oversized), SshCertificateErrorCode.INVALID_PUBLIC_KEY)
  })

  it.each([
    ['no base64 body', 'ssh-ed25519'],
    ['non-base64 body', 'ssh-ed25519 not-base64!!'],
    ['multi-line input', `${generateOpenSshEd25519PublicKey()}\nssh-ed25519 AAAA`],
  ])('rejects malformed input (%s) with INVALID_PUBLIC_KEY', (_label, input) => {
    expectErrorCode(() => parseSshPublicKey(input), SshCertificateErrorCode.INVALID_PUBLIC_KEY)
  })

  it('rejects a blob whose embedded algorithm disagrees with the prefix', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const blob = ed25519SpkiToOpenSshBlob(publicKey.export({ format: 'der', type: 'spki' }) as Buffer)

    expectErrorCode(
      () => parseSshPublicKey(formatOpenSshPublicKey(blob, 'ssh-rsa')),
      SshCertificateErrorCode.INVALID_PUBLIC_KEY,
    )
  })

  it('rejects an Ed25519 blob with trailing bytes', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const blob = ed25519SpkiToOpenSshBlob(publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    const padded = Buffer.concat([blob, Buffer.from([0x00])])

    expectErrorCode(() => parseSshPublicKey(formatOpenSshPublicKey(padded)), SshCertificateErrorCode.INVALID_PUBLIC_KEY)
  })

  it('rejects an OpenSSH certificate passed where a public key is expected', () => {
    const certificateBlob = new SshWireWriter()
      .writeString('ssh-ed25519-cert-v01@openssh.com')
      .writeString(randomBytes(32))
      .writeString(randomBytes(32))
      .toBuffer()

    expectErrorCode(
      () => parseSshPublicKey(`ssh-ed25519-cert-v01@openssh.com ${certificateBlob.toString('base64')}`),
      SshCertificateErrorCode.INVALID_PUBLIC_KEY,
    )
  })

  it('rejects a well-formed non-Ed25519 key with UNSUPPORTED_KEY_ALGORITHM', () => {
    const rsaBlob = new SshWireWriter()
      .writeString('ssh-rsa')
      .writeString(Buffer.from([0x01, 0x00, 0x01]))
      .writeString(randomBytes(256))
      .toBuffer()

    expectErrorCode(
      () => parseSshPublicKey(formatOpenSshPublicKey(rsaBlob, 'ssh-rsa')),
      SshCertificateErrorCode.UNSUPPORTED_KEY_ALGORITHM,
    )
  })

  it('rejects an Ed25519 blob whose key material is the wrong length', () => {
    const shortBlob = new SshWireWriter().writeString('ssh-ed25519').writeString(randomBytes(16)).toBuffer()

    expectErrorCode(
      () => parseSshPublicKey(formatOpenSshPublicKey(shortBlob)),
      SshCertificateErrorCode.INVALID_PUBLIC_KEY,
    )
  })
})

describe('ed25519SpkiToOpenSshBlob', () => {
  it('extracts the 32-byte point from a DER SubjectPublicKeyInfo', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer

    const blob = ed25519SpkiToOpenSshBlob(der)

    expect(blob.subarray(blob.length - 32).equals(der.subarray(der.length - 32))).toBe(true)
    expect(parseSshPublicKey(formatOpenSshPublicKey(blob)).keyMaterial).toEqual(der.subarray(der.length - 32))
  })

  it('rejects a SubjectPublicKeyInfo for a different algorithm', () => {
    const { publicKey } = generateKeyPairSync('x25519')
    const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer

    expect(() => ed25519SpkiToOpenSshBlob(der)).toThrow('not an Ed25519')
  })
})

describe('sshPublicKeyFingerprint', () => {
  it('produces the unpadded base64 SHA256 form OpenSSH prints', () => {
    const blob = encodeEd25519PublicKeyBlob(Buffer.alloc(32, 7))

    expect(sshPublicKeyFingerprint(blob)).not.toMatch(/=/)
    expect(sshPublicKeyFingerprint(blob).startsWith('SHA256:')).toBe(true)
  })
})
