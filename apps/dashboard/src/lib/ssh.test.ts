import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/apiClient'
import { generateSshCredentials, requestSsh, sshConnectionInstructions } from './ssh'

afterEach(() => vi.unstubAllGlobals())

describe('SSH credentials', () => {
  it('produces independent OpenSSH keys and sends only the client public key', async () => {
    const credentials = await generateSshCredentials()
    const directory = mkdtempSync(join(tmpdir(), 'boxlite-ssh-test-'))
    try {
      const publicKey = (name: string, key: string) => {
        const path = join(directory, name)
        writeFileSync(path, key, { mode: 0o600 })
        return execFileSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' })
          .trim()
          .split(' ')
          .slice(0, 2)
          .join(' ')
      }
      const client = publicKey('client', credentials.privateKey)
      const host = publicKey('host', credentials.config.host_private_key)
      expect(credentials.config.accounts).toEqual([{ login: 'box', authorized_keys: [client] }])
      expect(credentials.config.listen_address).toBe('0.0.0.0:22')
      expect(host).not.toBe(client)
      expect(credentials.hostPublicKey).toBe(host)
      expect(credentials.config).not.toHaveProperty('hostPublicKey')
      expect(JSON.stringify(credentials.config)).not.toContain(credentials.privateKey.trim())
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails explicitly without browser crypto', async () => {
    vi.stubGlobal('crypto', undefined)
    await expect(generateSshCredentials()).rejects.toThrow('secure browser context')
  })
})

describe('SSH REST boundary', () => {
  it('refuses setup without credentials before making a request', async () => {
    const post = vi.fn()
    const api = { axiosInstance: { post } } as unknown as ApiClient
    await expect(requestSsh(api, 'org', 'box', 'setup')).rejects.toThrow('SSH setup requires credentials')
    expect(post).not.toHaveBeenCalled()
  })

  it('encodes the scope and uses each existing endpoint without retrying', async () => {
    const status = { enabled: false, generation: 0, listen_address: '', host_public_key: '', host_key_fingerprint: '' }
    const http = {
      get: vi.fn().mockResolvedValue({ data: status }),
      post: vi.fn().mockResolvedValue({ data: status }),
      delete: vi.fn().mockResolvedValue({ data: status }),
    }
    const api = { axiosInstance: http } as unknown as ApiClient
    const credentials = await generateSshCredentials()
    const path = 'v1/org%2Fa/boxes/box%20b/ssh'
    expect(await requestSsh(api, 'org/a', 'box b', 'status')).toBe(status)
    await requestSsh(api, 'org/a', 'box b', 'setup', credentials.config)
    await requestSsh(api, 'org/a', 'box b', 'enable')
    await requestSsh(api, 'org/a', 'box b', 'disable')
    expect(http.get).toHaveBeenCalledWith(path, { timeout: 30_000 })
    expect(http.post.mock.calls).toEqual([
      [path, credentials.config, { timeout: 30_000 }],
      [`${path}/enable`, undefined, { timeout: 30_000 }],
    ])
    expect(http.delete).toHaveBeenCalledWith(path, { timeout: 30_000 })
    http.post.mockRejectedValueOnce(new Error('timeout'))
    await expect(requestSsh(api, 'org/a', 'box b', 'setup', credentials.config)).rejects.toThrow('timeout')
    expect(http.post).toHaveBeenCalledTimes(3)
  })

  it('rejects incomplete status instead of reporting SSH disabled', async () => {
    const api = { axiosInstance: { get: vi.fn().mockResolvedValue({ data: {} }) } } as unknown as ApiClient
    await expect(requestSsh(api, 'org', 'box', 'status')).rejects.toThrow('Invalid SSH status')
  })
})

describe('SSH connection instructions', () => {
  it.each([
    '~/space key',
    "./quote'key",
    './percent%h-key',
    './back\\slash"%key',
    '-leading-key',
    './$(touch injected)',
  ])('loads the exact SSH key at %s', async (path) => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    const directory = mkdtempSync(join(tmpdir(), 'boxlite-ssh-path-'))
    try {
      const credentials = await generateSshCredentials()
      const file = join(directory, path.replace(/^(~|\.)\//, ''))
      writeFileSync(file, credentials.privateKey, { mode: 0o644 })
      const commands = sshConnectionInstructions('/api', 'org', 'box-1', path)
      writeFileSync(join(directory, 'boxlite'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
      const result = spawnSync(
        '/bin/sh',
        ['-c', commands.connect.replace('\nssh ', '\nssh -vv -F /dev/null -o BatchMode=yes ')],
        {
          cwd: directory,
          env: { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}` },
          encoding: 'utf8',
          timeout: 5000,
        },
      )
      expect(result.error).toBeUndefined()
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(result.stderr).toMatch(/identity file .* type 3/)
      expect(result.stderr).not.toContain('not accessible')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['', ' ', '~/bad\nkey', '~other/key', '${HOME}/key'])('rejects ambiguous SSH key path %j', (path) => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    expect(() => sshConnectionInstructions('/api', 'org', 'box-1', path)).toThrow()
  })

  it('uses the supplied private key path without selecting a different CLI context', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    const build = sshConnectionInstructions as (...args: string[]) => ReturnType<typeof sshConnectionInstructions>
    const commands = build('/api', 'org', 'box-1', '/tmp/my private key')
    expect(commands.connect).toContain("chmod 600 '/tmp/my private key'")
    expect(commands.connect).toContain("ssh -i '/tmp/my private key'")
    expect(commands.connect).not.toContain('--context')
  })

  it('keeps ordinary IDs readable with only the outer ProxyCommand quotes', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    const commands = sshConnectionInstructions('https://api.example.test', 'mock-org-00000000', 'mock-box-running')
    expect(commands.connect).toBe(
      'chmod 600 boxlite-mock-box-running-key\n' +
        "ssh -i ./boxlite-mock-box-running-key -o IdentitiesOnly=yes -o 'ProxyCommand=boxlite --path-prefix=mock-org-00000000 ssh --proxy -- mock-box-running' box@boxlite-mock-box-running",
    )
  })

  it('preserves cloud routing through the shell and OpenSSH proxy expansion', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    const apiUrl = 'https://api.example.test/a%20b'
    const organization = "org'$(touch nope)%h `ticks`"
    const commands = sshConnectionInstructions(apiUrl, organization, 'box-1')
    const credentials = await generateSshCredentials()
    const directory = mkdtempSync(join(tmpdir(), 'boxlite-ssh-proxy-test-'))
    try {
      const record = join(directory, 'proxy-args')
      writeFileSync(join(directory, commands.filename), credentials.privateKey, { mode: 0o600 })
      writeFileSync(join(directory, 'boxlite'), '#!/bin/sh\nprintf \'%s\\0\' "$@" > "$SSH_PROXY_RECORD"\n', {
        mode: 0o700,
      })
      const result = spawnSync(
        '/bin/sh',
        ['-c', commands.connect.replace('\nssh ', '\nssh -F /dev/null -o BatchMode=yes -o ConnectTimeout=2 ')],
        {
          cwd: directory,
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SSH_PROXY_RECORD: record },
          encoding: 'utf8',
          timeout: 5000,
        },
      )
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0) // The recording proxy cannot finish an SSH handshake.
      expect(readFileSync(record, 'utf8').split('\0').filter(Boolean)).toEqual([
        `--path-prefix=${organization}`,
        'ssh',
        '--proxy',
        '--',
        'box-1',
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
    expect(commands.connect).toContain(`chmod 600 ${commands.filename}`)
    expect(commands.connect).toContain('box@boxlite-box-1')
    expect(commands.connect).not.toContain('--listen')
    expect(commands.connect).not.toContain('--url')
    expect(commands.connect).not.toContain('--context')
    expect(commands.connect).not.toContain('StrictHostKeyChecking=no')
  })

  it('refuses control characters, unsafe box IDs, and credential-bearing URLs', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:3000' } })
    expect(() => sshConnectionInstructions('/api', 'org\n1', 'box-1')).toThrow()
    expect(() => sshConnectionInstructions('/api', 'org', '$(id)')).toThrow()
    expect(() => sshConnectionInstructions('https://secret@example.test', 'org', 'box-1')).toThrow()
  })
})
