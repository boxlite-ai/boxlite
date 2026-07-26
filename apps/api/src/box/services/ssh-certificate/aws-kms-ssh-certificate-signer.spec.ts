/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms'
import { execFileSync } from 'child_process'
import { generateKeyPairSync, KeyObject, sign as signWithKey } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrganizationSshCaKey, OrganizationSshCaKeyStatus } from '../../entities/organization-ssh-ca-key.entity'
import { AwsKmsSshCertificateSigner } from './aws-kms-ssh-certificate-signer'
import { ed25519SpkiToOpenSshBlob, formatOpenSshPublicKey, parseSshPublicKey } from './openssh-public-key'
import { OrganizationSshCaKeyService } from './organization-ssh-ca-key.service'
import { SshCertificateError, SshCertificateErrorCode } from './ssh-certificate.errors'

const ORGANIZATION_ID = '11111111-2222-3333-4444-555555555555'
const BOX_ID = 'box-01hzzzzzzzzzzzzzzzzzzzzzzz'
const PROVIDER_KEY_REF = 'arn:aws:kms:us-east-1:000000000000:key/ca'

interface KmsStubCalls {
  getPublicKey: number
  sign: Array<{ KeyId?: string; MessageType?: string; SigningAlgorithm?: string; Message?: Uint8Array }>
}

/**
 * Stands in for KMS with a real Ed25519 key so the adapter's exact wire output
 * can be verified end to end, including the DER SPKI conversion.
 */
function kmsStub(
  privateKey: KeyObject,
  publicKey: KeyObject,
  overrides: { keySpec?: string; publicKeyDer?: Buffer; signature?: Buffer } = {},
): { client: KMSClient; calls: KmsStubCalls } {
  const calls: KmsStubCalls = { getPublicKey: 0, sign: [] }
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GetPublicKeyCommand) {
        calls.getPublicKey += 1
        return {
          KeySpec: overrides.keySpec ?? 'ECC_NIST_EDWARDS25519',
          PublicKey: overrides.publicKeyDer ?? (publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
        }
      }
      if (command instanceof SignCommand) {
        calls.sign.push(command.input)
        const message = Buffer.from(command.input.Message ?? [])
        return { Signature: overrides.signature ?? signWithKey(null, message, privateKey) }
      }
      throw new Error('unexpected KMS command')
    },
  } as unknown as KMSClient

  return { client, calls }
}

function caKeyServiceStub(caKey: OrganizationSshCaKey | Error): OrganizationSshCaKeyService {
  return {
    getCurrent: async () => {
      if (caKey instanceof Error) {
        throw caKey
      }
      return caKey
    },
  } as unknown as OrganizationSshCaKeyService
}

function buildRequest(clientPublicKey: string) {
  return {
    organizationId: ORGANIZATION_ID,
    boxId: BOX_ID,
    loginUsername: 'root',
    validPrincipals: ['root', `box:${BOX_ID}`, `org:${ORGANIZATION_ID}`],
    keyId: 'credential-id',
    serial: 42n,
    publicKey: parseSshPublicKey(clientPublicKey),
    validAfter: new Date('2026-07-26T12:00:00.000Z'),
    validBefore: new Date('2026-07-26T12:05:00.000Z'),
  }
}

let workDir: string
let clientPublicKey: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'boxlite-kms-signer-'))
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(workDir, 'client')])
  clientPublicKey = readFileSync(join(workDir, 'client.pub'), 'utf8').trim()
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function caKeyFor(publicKey: KeyObject): OrganizationSshCaKey {
  return {
    id: 'ca-row-id',
    organizationId: ORGANIZATION_ID,
    keyId: 'org-ca-v1',
    providerKeyRef: PROVIDER_KEY_REF,
    publicKey: formatOpenSshPublicKey(
      ed25519SpkiToOpenSshBlob(publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
    ),
    status: OrganizationSshCaKeyStatus.CURRENT,
    createdAt: new Date(),
    activatedAt: new Date(),
    retiredAt: null,
  }
}

describe('AwsKmsSshCertificateSigner', () => {
  it('signs with ED25519_SHA_512 over the raw certificate body and emits a cert real OpenSSH accepts', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const { client, calls } = kmsStub(privateKey, publicKey)
    const signer = new AwsKmsSshCertificateSigner(caKeyServiceStub(caKeyFor(publicKey)), {}, client)

    const signed = await signer.sign(buildRequest(clientPublicKey))

    expect(calls.sign).toHaveLength(1)
    expect(calls.sign[0].KeyId).toBe(PROVIDER_KEY_REF)
    expect(calls.sign[0].MessageType).toBe('RAW')
    expect(calls.sign[0].SigningAlgorithm).toBe('ED25519_SHA_512')
    expect(signed.caKeyId).toBe('org-ca-v1')
    expect(signed.serial).toBe(42n)

    const certificatePath = join(workDir, 'kms-cert.pub')
    writeFileSync(certificatePath, `${signed.certificate}\n`)
    const inspected = execFileSync('ssh-keygen', ['-L', '-f', certificatePath], { encoding: 'utf8' })
    expect(inspected).toContain('Type: ssh-ed25519-cert-v01@openssh.com user certificate')
    expect(inspected).toContain('Serial: 42')
    expect(inspected).toContain('Key ID: "credential-id"')
  })

  it('fetches the CA public key once and reuses it across signings', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const { client, calls } = kmsStub(privateKey, publicKey)
    const signer = new AwsKmsSshCertificateSigner(caKeyServiceStub(caKeyFor(publicKey)), {}, client)

    await signer.sign(buildRequest(clientPublicKey))
    await signer.sign(buildRequest(clientPublicKey))

    expect(calls.getPublicKey).toBe(1)
    expect(calls.sign).toHaveLength(2)
  })

  it('refuses to sign when KMS returns a different key than the recorded CA public key', async () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const { publicKey: unrelatedPublicKey } = generateKeyPairSync('ed25519')
    const { publicKey: recordedPublicKey } = generateKeyPairSync('ed25519')
    const { client } = kmsStub(privateKey, unrelatedPublicKey)
    const signer = new AwsKmsSshCertificateSigner(caKeyServiceStub(caKeyFor(recordedPublicKey)), {}, client)

    await expect(signer.sign(buildRequest(clientPublicKey))).rejects.toMatchObject({
      code: SshCertificateErrorCode.SSH_CA_UNAVAILABLE,
    })
  })

  it('rejects a CA key that is not ECC_NIST_EDWARDS25519', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const { client } = kmsStub(privateKey, publicKey, { keySpec: 'ECC_NIST_P256' })
    const signer = new AwsKmsSshCertificateSigner(caKeyServiceStub(caKeyFor(publicKey)), {}, client)

    await expect(signer.sign(buildRequest(clientPublicKey))).rejects.toMatchObject({
      code: SshCertificateErrorCode.SSH_CA_UNAVAILABLE,
    })
  })

  it('rejects a signature that is not 64 bytes', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const { client } = kmsStub(privateKey, publicKey, { signature: Buffer.alloc(32) })
    const signer = new AwsKmsSshCertificateSigner(caKeyServiceStub(caKeyFor(publicKey)), {}, client)

    await expect(signer.sign(buildRequest(clientPublicKey))).rejects.toMatchObject({
      code: SshCertificateErrorCode.SSH_CA_UNAVAILABLE,
    })
  })

  it('propagates SSH_CA_UNAVAILABLE when the organization has no current CA key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const { client } = kmsStub(privateKey, publicKey)
    const signer = new AwsKmsSshCertificateSigner(
      caKeyServiceStub(SshCertificateError.caUnavailable('no current CA key')),
      {},
      client,
    )

    await expect(signer.sign(buildRequest(clientPublicKey))).rejects.toMatchObject({
      code: SshCertificateErrorCode.SSH_CA_UNAVAILABLE,
    })
  })
})
