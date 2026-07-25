/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Client-side ephemeral Ed25519 keypair generation for SSH credentials. Per
// the design, the private key is generated in the browser and only the
// public key is ever submitted to the API -- it never leaves this module
// except as the one-time value handed back to the caller for the user to
// save.

export interface SshKeyPair {
  publicKeyLine: string
  privateKeyPem: string
}

const OPENSSH_MAGIC = 'openssh-key-v1\0'
const LINE_WRAP = 70

export async function generateEphemeralSshKeyPair(comment = 'boxlite-dashboard'): Promise<SshKeyPair> {
  const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])

  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
  const seed = extractEd25519SeedFromPkcs8(new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey)))

  return {
    publicKeyLine: `ssh-ed25519 ${bytesToBase64(encodeEd25519PublicKeyBlob(rawPublicKey))} ${comment}`,
    privateKeyPem: encodeOpenSshPrivateKey(rawPublicKey, seed, comment),
  }
}

// An unencrypted Ed25519 PKCS#8 DER document is a fixed 16-byte header
// followed by the 32-byte raw seed -- there are no variable-length fields
// (no attributes, no algorithm parameters) to parse around.
function extractEd25519SeedFromPkcs8(pkcs8: Uint8Array): Uint8Array {
  if (pkcs8.length !== 48) {
    throw new Error(`unexpected Ed25519 PKCS#8 length: ${pkcs8.length}`)
  }
  return pkcs8.subarray(16)
}

function encodeEd25519PublicKeyBlob(rawPublicKey: Uint8Array): Uint8Array {
  return concatWireStrings([stringToBytes('ssh-ed25519'), rawPublicKey])
}

// Builds an unencrypted "openssh-key-v1" private key file (RFC-less, but
// specified in OpenSSH's PROTOCOL.key): magic, cipher/kdf set to "none", one
// key entry holding the public blob and a private section (checkint pair +
// keytype + pubkey + seed‖pubkey + comment), padded to the cipher block size.
function encodeOpenSshPrivateKey(rawPublicKey: Uint8Array, seed: Uint8Array, comment: string): string {
  const publicKeyBlob = encodeEd25519PublicKeyBlob(rawPublicKey)

  const checkint = crypto.getRandomValues(new Uint8Array(4))
  const privateSectionParts = [
    checkint,
    checkint,
    lengthPrefixed(stringToBytes('ssh-ed25519')),
    lengthPrefixed(rawPublicKey),
    lengthPrefixed(concatBytes([seed, rawPublicKey])),
    lengthPrefixed(stringToBytes(comment)),
  ]
  let privateSection = concatBytes(privateSectionParts)
  // PKCS#5-style padding (1, 2, 3, ...) up to a multiple of the "none"
  // cipher's block size (8), as OpenSSH's own encoder does.
  let padByte = 1
  const padded: number[] = []
  while ((privateSection.length + padded.length) % 8 !== 0) {
    padded.push(padByte++)
  }
  if (padded.length > 0) {
    privateSection = concatBytes([privateSection, Uint8Array.from(padded)])
  }

  const body = concatWireStrings([
    stringToBytes('none'), // ciphername
    stringToBytes('none'), // kdfname
    new Uint8Array(0), // kdfoptions (empty)
  ])
  const numKeys = new Uint8Array(4)
  new DataView(numKeys.buffer).setUint32(0, 1)

  const document = concatBytes([
    stringToBytes(OPENSSH_MAGIC).subarray(0, OPENSSH_MAGIC.length), // includes trailing NUL
    body,
    numKeys,
    lengthPrefixed(publicKeyBlob),
    lengthPrefixed(privateSection),
  ])

  const base64 = bytesToBase64(document)
  const lines: string[] = []
  for (let i = 0; i < base64.length; i += LINE_WRAP) {
    lines.push(base64.slice(i, i + LINE_WRAP))
  }
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, bytes.length)
  return concatBytes([length, bytes])
}

// SSH-wire "string" fields are length-prefixed; this wraps each input
// buffer with its own prefix and concatenates the results.
function concatWireStrings(parts: Uint8Array[]): Uint8Array {
  return concatBytes(parts.map(lengthPrefixed))
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
