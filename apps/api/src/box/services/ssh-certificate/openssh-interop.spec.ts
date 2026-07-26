/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { execFileSync, spawn } from 'child_process'
import { createServer } from 'net'
import type { AddressInfo } from 'net'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'
import { LocalSshCertificateSigner } from './local-ssh-certificate-signer'
import { parseSshPublicKey } from './openssh-public-key'
import { SSH_CERTIFICATE_LOGIN_USERNAME } from './ssh-certificate.service'

/**
 * Interoperability gate: the certificates this module emits must be readable by
 * a real OpenSSH `ssh-keygen`, byte for byte. If `ssh-keygen` cannot parse the
 * blob it prints "invalid format" and exits non-zero, so a format regression
 * fails this test rather than a guest at connect time.
 */

const BOX_ID = 'box-01hzzzzzzzzzzzzzzzzzzzzzzz'
const ORGANIZATION_ID = '11111111-2222-3333-4444-555555555555'
const CREDENTIAL_ID = '99999999-8888-7777-6666-555555555555'

let workDir: string

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'boxlite-ssh-interop-'))
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function sshKeygen(...args: string[]): string {
  return execFileSync('ssh-keygen', args, { encoding: 'utf8' })
}

/** A real client key pair produced by OpenSSH itself, not by this codebase. */
function generateClientKeyWithSshKeygen(name: string): { privateKeyPath: string; publicKey: string } {
  const privateKeyPath = join(workDir, name)
  sshKeygen('-q', '-t', 'ed25519', '-N', '', '-C', 'interop@boxlite', '-f', privateKeyPath)
  return { privateKeyPath, publicKey: readFileSync(`${privateKeyPath}.pub`, 'utf8').trim() }
}

async function issueCertificate(publicKey: string, validAfter: Date, validBefore: Date) {
  const signer = LocalSshCertificateSigner.generate('interop-ca-v1')
  const signed = await signer.sign({
    organizationId: ORGANIZATION_ID,
    boxId: BOX_ID,
    loginUsername: SSH_CERTIFICATE_LOGIN_USERNAME,
    validPrincipals: [SSH_CERTIFICATE_LOGIN_USERNAME, `box:${BOX_ID}`, `org:${ORGANIZATION_ID}`],
    keyId: CREDENTIAL_ID,
    serial: 1234567890123456789n,
    publicKey: parseSshPublicKey(publicKey),
    validAfter,
    validBefore,
  })
  return { signer, signed }
}

describe('OpenSSH interoperability', () => {
  it('accepts an ssh-keygen generated public key and canonicalizes it identically', () => {
    const { publicKey } = generateClientKeyWithSshKeygen('canonical-key')

    const parsed = parseSshPublicKey(publicKey)

    expect(parsed.openssh).toBe(publicKey.split(' ').slice(0, 2).join(' '))
    // `ssh-keygen -l -f` prints "<bits> SHA256:<hash> <comment> (ED25519)".
    const printedFingerprint = sshKeygen('-l', '-f', join(workDir, 'canonical-key.pub')).split(' ')[1]
    expect(parsed.fingerprint).toBe(printedFingerprint)
  })

  it('emits a user certificate that ssh-keygen -L parses with the exact BoxLite profile', async () => {
    const { privateKeyPath, publicKey } = generateClientKeyWithSshKeygen('profile-key')
    const validAfter = new Date('2026-07-26T12:00:00.000Z')
    const validBefore = new Date('2026-07-26T12:05:00.000Z')

    const { signer, signed } = await issueCertificate(publicKey, validAfter, validBefore)
    const certificatePath = `${privateKeyPath}-cert.pub`
    writeFileSync(certificatePath, `${signed.certificate} interop@boxlite\n`)

    const inspected = sshKeygen('-L', '-f', certificatePath)

    expect(inspected).toContain('Type: ssh-ed25519-cert-v01@openssh.com user certificate')
    expect(inspected).toContain(`Public key: ED25519-CERT ${parseSshPublicKey(publicKey).fingerprint}`)
    expect(inspected).toContain(`Key ID: "${CREDENTIAL_ID}"`)
    expect(inspected).toContain('Serial: 1234567890123456789')
    expect(inspected).toContain('(using ssh-ed25519)')
    expect(inspected).toMatch(/Principals:\s+root\s+box:box-01hzzzzzzzzzzzzzzzzzzzzzzz\s+org:11111111-2222-3333-4444-555555555555/)
    expect(inspected).toContain('Critical Options: (none)')
    expect(inspected).toMatch(/Extensions:\s+permit-pty/)

    // The CA fingerprint ssh-keygen prints must match the CA public key we would
    // hand to guests, proving the embedded signature key is the CA we signed with.
    const caPublicKeyPath = join(workDir, 'interop-ca.pub')
    writeFileSync(caPublicKeyPath, `${signer.caPublicKeyOpenssh} interop-ca\n`)
    const caFingerprint = sshKeygen('-l', '-f', caPublicKeyPath).split(' ')[1]
    expect(inspected).toContain(`Signing CA: ED25519 ${caFingerprint}`)
  })

  it('encodes the validity window ssh-keygen reports back', async () => {
    const { privateKeyPath, publicKey } = generateClientKeyWithSshKeygen('validity-key')
    const validAfter = new Date('2026-07-26T12:00:00.000Z')
    const validBefore = new Date('2026-07-26T12:05:00.000Z')

    const { signed } = await issueCertificate(publicKey, validAfter, validBefore)
    const certificatePath = `${privateKeyPath}-cert.pub`
    writeFileSync(certificatePath, `${signed.certificate}\n`)

    // ssh-keygen renders the window in local time, so compare against the same
    // conversion instead of hard-coding a timezone.
    const localTimestamp = (date: Date) =>
      new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 19)
    expect(sshKeygen('-L', '-f', certificatePath)).toContain(
      `Valid: from ${localTimestamp(validAfter)} to ${localTimestamp(validBefore)}`,
    )
  })

  it('produces a certificate that fails ssh-keygen parsing when a single byte is corrupted', async () => {
    const { privateKeyPath, publicKey } = generateClientKeyWithSshKeygen('corrupt-key')
    const { signed } = await issueCertificate(
      publicKey,
      new Date('2026-07-26T12:00:00.000Z'),
      new Date('2026-07-26T12:05:00.000Z'),
    )

    const [algorithm, body] = signed.certificate.split(' ')
    const raw = Buffer.from(body, 'base64')
    // Corrupt the certificate algorithm string so the blob stops being a
    // well-formed OpenSSH certificate.
    raw[8] ^= 0xff
    const certificatePath = `${privateKeyPath}-cert.pub`
    writeFileSync(certificatePath, `${algorithm} ${raw.toString('base64')}\n`)

    expect(() => sshKeygen('-L', '-f', certificatePath)).toThrow()
  })
})

/**
 * The strongest interop statement available without a VM: a real OpenSSH
 * `sshd`, configured to trust only our CA, completes an authenticated session
 * using a certificate this module signed.
 *
 * `ssh-keygen -L` proves the blob *parses*; it does not verify the CA
 * signature and never exercises the authentication path. Only a real server
 * does. The design makes OpenSSH interoperability a merge gate rather than a
 * staging assumption, so it belongs here.
 *
 * Our certificates carry the principals `root`, `box:<id>` and `org:<id>`;
 * none matches the local test user, so `AuthorizedPrincipalsFile` tells sshd
 * which principals may act as that user. That is precisely the mapping a real
 * deployment relies on, and it exercises principal handling rather than
 * bypassing it.
 */
describe('OpenSSH sshd interoperability', () => {
  const sshdPath = '/usr/sbin/sshd'

  function sshdAvailable(): boolean {
    try {
      return existsSync(sshdPath) && existsSync('/usr/bin/ssh')
    } catch {
      return false
    }
  }

  const maybeIt = sshdAvailable() ? it : it.skip

  maybeIt(
    'authenticates a real sshd session with a certificate signed by our CA',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'boxlite-sshd-'))
      let sshd: ReturnType<typeof spawn> | undefined
      try {
        const { privateKeyPath, publicKey } = generateClientKeyWithSshKeygen('sshd-client')
        const { signer, signed } = await issueCertificate(
          publicKey,
          new Date(Date.now() - 60_000),
          new Date(Date.now() + 300_000),
        )

        writeFileSync(`${privateKeyPath}-cert.pub`, signed.certificate)

        // Trust anchor: ONLY our CA public key. Nothing else can authenticate.
        const caPath = join(dir, 'ca.pub')
        writeFileSync(caPath, `${signer.caPublicKeyOpenssh} interop-ca\n`)

        const principalsPath = join(dir, 'principals')
        writeFileSync(principalsPath, `${SSH_CERTIFICATE_LOGIN_USERNAME}\n`)

        const hostKeyPath = join(dir, 'host_ed25519')
        sshKeygen('-q', '-t', 'ed25519', '-N', '', '-f', hostKeyPath)
        chmodSync(hostKeyPath, 0o600)

        const configPath = join(dir, 'sshd_config')
        writeFileSync(
          configPath,
          [
            `HostKey ${hostKeyPath}`,
            `TrustedUserCAKeys ${caPath}`,
            `AuthorizedPrincipalsFile ${principalsPath}`,
            'AuthenticationMethods publickey',
            'PubkeyAuthentication yes',
            'PasswordAuthentication no',
            'KbdInteractiveAuthentication no',
            'UsePAM no',
            // The fixture lives in a temp dir owned by the test user; sshd's
            // ownership heuristics would otherwise refuse to start.
            'StrictModes no',
            `PidFile ${join(dir, 'sshd.pid')}`,
            'LogLevel VERBOSE',
            '',
          ].join('\n'),
        )

        // Ask the OS for a free port instead of guessing one: a collision makes
        // sshd exit at startup, which surfaces as "sshd did not start" rather
        // than anything diagnostic, and would be flaky under parallel CI.
        const port = await new Promise<number>((resolve, reject) => {
          const probe = createServer()
          probe.on('error', reject)
          probe.listen(0, '127.0.0.1', () => {
            const assigned = (probe.address() as AddressInfo).port
            probe.close(() => resolve(assigned))
          })
        })
        sshd = spawn(sshdPath, ['-D', '-e', '-p', String(port), '-f', configPath])

        const stderr: string[] = []
        sshd.stderr?.on('data', (chunk) => stderr.push(String(chunk)))

        const listening = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 15_000)
          sshd?.stderr?.on('data', (chunk) => {
            if (String(chunk).includes('Server listening')) {
              clearTimeout(timer)
              resolve(true)
            }
          })
          sshd?.on('exit', () => {
            clearTimeout(timer)
            resolve(false)
          })
        })
        if (!listening) {
          // Environment refused to run sshd (sandbox, missing perms). Say so
          // rather than passing vacuously.
          throw new Error(`sshd did not start: ${stderr.join('')}`)
        }

        // Pin the host key we just generated instead of disabling checking.
        const knownHosts = join(dir, 'known_hosts')
        writeFileSync(
          knownHosts,
          `[127.0.0.1]:${port} ${readFileSync(`${hostKeyPath}.pub`, 'utf8').trim()}\n`,
        )

        const sshArgs = (identity: string, extra: string[] = []) => [
          '-i', identity,
          ...extra,
          '-o', `UserKnownHostsFile=${knownHosts}`,
          '-o', 'StrictHostKeyChecking=yes',
          '-o', 'IdentitiesOnly=yes',
          '-o', 'BatchMode=yes',
          '-p', String(port),
          `${userInfo().username}@127.0.0.1`,
          'echo BOXLITE_CERT_AUTH_OK',
        ]

        // Positive: the certificate we signed authenticates against a server
        // whose only trust anchor is our CA.
        const output = execFileSync(
          '/usr/bin/ssh',
          sshArgs(privateKeyPath, ['-o', `CertificateFile=${privateKeyPath}-cert.pub`]),
          { encoding: 'utf8', timeout: 30_000 },
        )
        expect(output).toContain('BOXLITE_CERT_AUTH_OK')

        // Negative control: an uncertified key of the same type must be
        // refused. This is what proves the session above was authorized by the
        // CA signature rather than by possession of any key the server would
        // have accepted anyway.
        //
        // It uses a *separate* key deliberately: ssh(1) auto-loads
        // `<identity>-cert.pub` when it sits next to the private key, so
        // merely dropping the `CertificateFile` option would still present the
        // certificate and the control would silently pass.
        const { privateKeyPath: uncertifiedKey } = generateClientKeyWithSshKeygen('sshd-uncertified')
        expect(() =>
          execFileSync('/usr/bin/ssh', sshArgs(uncertifiedKey), {
            encoding: 'utf8',
            timeout: 30_000,
            stdio: 'pipe',
          }),
        ).toThrow()
      } finally {
        sshd?.kill('SIGTERM')
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
