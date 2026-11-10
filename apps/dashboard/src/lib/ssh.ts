/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */

import type { ApiClient } from '@/api/apiClient'

export type SshStatus = {
  enabled: boolean
  generation: number
  listen_address: string
  host_public_key: string
  host_key_fingerprint: string
}

type SshConfig = {
  listen_address: string
  host_private_key: string
  accounts: { login: string; authorized_keys: string[] }[]
}

export type SshCredentials = { privateKey: string; hostPublicKey: string; config: SshConfig }

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function sshString(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return concat(uint32(bytes.length), bytes)
}

function decodeBase64Url(value: string): Uint8Array {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}

async function generateKey(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  if (!jwk.x || !jwk.d) throw new Error('Unable to export SSH key')
  const publicBytes = decodeBase64Url(jwk.x)
  const seed = decodeBase64Url(jwk.d)
  const publicBlob = concat(sshString('ssh-ed25519'), sshString(publicBytes))
  const check = crypto.getRandomValues(new Uint8Array(4))
  // OpenSSH's Ed25519 secret is the seed followed by the public key.
  const secret = concat(check, check, publicBlob, sshString(concat(seed, publicBytes)), sshString('boxlite'))
  const padding = Uint8Array.from({ length: (8 - (secret.length % 8)) % 8 }, (_, i) => i + 1)
  const encoded = btoa(
    String.fromCharCode(
      ...concat(
        new TextEncoder().encode('openssh-key-v1\0'),
        sshString('none'),
        sshString('none'),
        sshString(''),
        uint32(1),
        sshString(publicBlob),
        sshString(concat(secret, padding)),
      ),
    ),
  )
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${encoded.replace(/.{1,70}/g, '$&\n')}-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${btoa(String.fromCharCode(...publicBlob))}`,
  }
}

export async function generateSshCredentials(): Promise<SshCredentials> {
  if (!globalThis.crypto?.subtle) throw new Error('SSH setup requires a secure browser context')
  const [client, host] = await Promise.all([generateKey(), generateKey()])
  return {
    privateKey: client.privateKey,
    hostPublicKey: host.publicKey,
    config: {
      listen_address: '0.0.0.0:22',
      host_private_key: host.privateKey,
      accounts: [{ login: 'box', authorized_keys: [client.publicKey] }],
    },
  }
}

export async function requestSsh(
  api: ApiClient,
  organizationId: string,
  boxId: string,
  operation: 'status' | 'setup' | 'enable' | 'disable',
  config?: SshConfig,
): Promise<SshStatus> {
  const path = `v1/${encodeURIComponent(organizationId)}/boxes/${encodeURIComponent(boxId)}/ssh`
  const http = api.axiosInstance
  const options = { timeout: 30_000 }
  if (operation === 'setup' && !config) throw new Error('SSH setup requires credentials')
  const response =
    operation === 'status'
      ? await http.get<SshStatus>(path, options)
      : operation === 'disable'
        ? await http.delete<SshStatus>(path, options)
        : operation === 'enable'
          ? await http.post<SshStatus>(`${path}/enable`, undefined, options)
          : await http.post<SshStatus>(path, config, options)
  const status = response.data
  if (
    !status ||
    typeof status.enabled !== 'boolean' ||
    !Number.isInteger(status.generation) ||
    status.generation < 0 ||
    !['listen_address', 'host_public_key', 'host_key_fingerprint'].every(
      (field) => typeof status[field as keyof SshStatus] === 'string',
    )
  ) {
    throw new Error('Invalid SSH status response')
  }
  return status
}

export function sshConnectionInstructions(apiUrl: string, organizationId: string, boxId: string, keyPath?: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(boxId)) throw new Error('Invalid box ID')
  const quote = (value: string) => {
    if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
      throw new Error('Invalid connection argument')
    if (/^[a-zA-Z0-9_-]+$/.test(value)) return value
    return `'${value.replace(/'/g, `'"'"'`)}'`
  }
  const url = new URL(apiUrl, window.location.origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid API URL')
  const endpoint = url.href.replace(/\/$/, '')
  // A dedicated context keeps saved/ambient context changes from redirecting SSH.
  // Login and proxy select the same endpoint-specific credentials without changing
  // the user's current context or overwriting their default profile. Clear the
  // ambient API key too: it otherwise overrides the context's saved credential.
  const cli = `env -u BOXLITE_REST_URL -u BOXLITE_API_KEY boxlite --context ${quote(`dashboard:${endpoint}`)}`
  // OpenSSH expands percent tokens before passing ProxyCommand to a shell.
  const proxy = `${cli} --path-prefix=${quote(organizationId)} ssh --proxy -- ${quote(boxId)}`.replace(/%/g, '%%')
  const filename = `boxlite-${boxId}-key`
  let chmodPath = filename
  let identity = `-i ./${filename}`
  if (keyPath !== undefined) {
    if (!keyPath.trim() || keyPath.includes('${') || (keyPath.startsWith('~') && !keyPath.startsWith('~/')))
      throw new Error('Use a literal key path or ~/path')
    // A bare "none" is OpenSSH's no-identity sentinel, not a relative filename.
    const path = keyPath.startsWith('-') || /^none$/i.test(keyPath) ? `./${keyPath}` : keyPath
    const shellPath = (value: string) => (value.startsWith('~/') ? `"$HOME"/${quote(value.slice(2))}` : quote(value))
    chmodPath = shellPath(path)
    // -i checks the literal file before expanding percent tokens. IdentityFile
    // avoids that pre-check so a literal percent reaches the same file as chmod.
    // OpenSSH tilde expansion uses the account home, which may differ from HOME.
    // Its environment expansion runs after percent expansion, preserving literal
    // percent characters in HOME as well as in the supplied filename.
    const identityPath = path.startsWith('~/') ? '${HOME}/' + path.slice(2) : path
    identity =
      path.includes('%') || path.startsWith('~/')
        ? `-o ${quote(`IdentityFile="${identityPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`)}`
        : `-i ${shellPath(path)}`
  }
  return {
    filename,
    endpoint,
    login: `${cli} auth login --url ${quote(endpoint)} --method api-key`,
    connect: `chmod 600 ${chmodPath}\nssh ${identity} -o IdentitiesOnly=yes -o ${quote(`ProxyCommand=${proxy}`)} box@boxlite-${boxId}`,
  }
}
